import type {
  EffectivePermissionSnapshot,
  PermissionProjectionInput
} from "../core/permissions/types";
import type { FieldTypeRegistry } from "../core/field-types/types";
import type { JsonValue } from "../core/field-types/types";
import type { ViewPlanner, ViewQueryConstraint } from "../core/views/planner";
import type { WorkflowOperatorRegistry } from "../core/workflows/types";
import { readPermissionSnapshot } from "./permission-snapshot";

type ViewRow = {
  current_schema_version: number;
  id: string;
  name: string;
  table_id: string;
  view_key: string;
};

type ViewSchemaRow = {
  schema_json: string;
};

type FieldRow = {
  config_json: string;
  field_key: string;
  field_type: string;
  id: string;
  label: string;
};

type RecordProjectionRow = {
  created_at: string;
  projection_json: string;
  record_id: string;
  record_key: string;
};

type ParsedViewSchema = {
  filterFieldIds: string[];
  filters: ViewFilterDefinition[];
  groupByFieldId: string | null;
  sortFieldIds: string[];
  sorts: ViewSortDefinition[];
  visibleFieldIds: string[];
};

type ViewFilterDefinition = {
  comparator?: string;
  fieldId: string;
  operatorId: string;
  value?: JsonValue;
};

type ViewSortDefinition = {
  fieldId: string;
  mode: string;
};

type ReadViewQueryInput = {
  permissionScopeHash?: string | null;
  policyRevision?: number | null;
  principalId?: string | null;
  snapshot?: EffectivePermissionSnapshot;
  tableId: string;
  viewId: string;
  workspaceId: string;
};

type ViewFieldMetadata = {
  fieldId: string;
  fieldKey: string;
  fieldType: string;
  label: string;
};

type ViewQueryRowResult = {
  cells: Record<string, unknown>;
  hiddenFieldIds: string[];
  recordId: string;
  recordKey: string;
  redactedFieldIds: string[];
  states: Record<string, "visible" | "redacted" | "hidden">;
};

export type ReadViewQueryResult = {
  fields: ViewFieldMetadata[];
  groups?: ViewQueryGroupResult[];
  rows: ViewQueryRowResult[];
  view: {
    allowed: boolean;
    blockedFieldIds: string[];
    consistencyModel: "view_eventual";
    deniedFieldIds: string[];
    diagnostics: string[];
    filters?: Array<ViewFilterDefinition & { protected: boolean }>;
    redactedFieldIds: string[];
    redactionApplied: boolean;
    tableId: string;
    viewId: string;
    viewKey: string;
    viewName: string;
    viewSchemaVersion: number;
    visibleFieldIds: string[];
  };
};

export type ViewQueryGroupResult = {
  bucketKey: string;
  groupLabel: string;
  rowCount: number;
  rows: ViewQueryRowResult[];
};

type ViewRecordQuery = {
  bindings: unknown[];
  sql: string;
};

type MaterializedViewRow = {
  comparisonInputs: PermissionProjectionInput[];
  filterInputs: PermissionProjectionInput[];
  groupBucketKey: string;
  groupLabel: string;
  recordId: string;
  recordKey: string;
  row: ViewQueryRowResult;
};

function parseViewSchema(raw: string): ParsedViewSchema {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const asFieldIdArray = (key: string) =>
    Array.isArray(parsed[key])
      ? (parsed[key] as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
  const filters = Array.isArray(parsed.filters)
    ? parsed.filters
        .filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value.fieldId === "string" &&
            typeof value.operatorId === "string"
        )
        .map((value) => ({
          comparator: typeof value.comparator === "string" ? value.comparator : undefined,
          fieldId: value.fieldId as string,
          operatorId: value.operatorId as string,
          value: value.value as JsonValue | undefined
        }))
    : [];
  const filterFieldIds =
    filters.length > 0 ? filters.map((filter) => filter.fieldId) : asFieldIdArray("filterFieldIds");
  const sorts = Array.isArray(parsed.sorts)
    ? parsed.sorts
        .filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value.fieldId === "string"
        )
        .map((value) => ({
          fieldId: value.fieldId as string,
          mode: typeof value.mode === "string" ? value.mode : "ascending"
        }))
    : [];
  const sortFieldIds =
    sorts.length > 0 ? sorts.map((sort) => sort.fieldId) : asFieldIdArray("sortFieldIds");

  return {
    filterFieldIds,
    filters:
      filters.length > 0
        ? filters
        : filterFieldIds.map((fieldId) => ({
            fieldId,
            operatorId: "is_not_empty"
          })),
    groupByFieldId: typeof parsed.groupByFieldId === "string" ? parsed.groupByFieldId : null,
    sortFieldIds,
    sorts:
      sorts.length > 0
        ? sorts
        : sortFieldIds.map((fieldId) => ({
            fieldId,
            mode: "ascending"
          })),
    visibleFieldIds: asFieldIdArray("visibleFieldIds")
  };
}

function buildViewRecordQuery(input: ReadViewQueryInput, schema: ParsedViewSchema): ViewRecordQuery {
  return {
    bindings: [input.workspaceId, input.tableId],
    sql: `SELECT records.id AS record_id, records.record_key, records.created_at, record_projection.projection_json
       FROM records
       INNER JOIN record_projection
         ON record_projection.workspace_id = records.workspace_id
        AND record_projection.table_id = records.table_id
        AND record_projection.record_id = records.id
       WHERE records.workspace_id = ?
         AND records.table_id = ?
         AND records.archived_at IS NULL
       ORDER BY records.record_key ASC, records.id ASC`
  };
}

function compareSortValues(
  fieldTypeRegistry: FieldTypeRegistry,
  field: FieldRow,
  left: unknown,
  right: unknown,
  mode: string
): number {
  const definition = fieldTypeRegistry.require(field.field_type);
  const context = {
    fieldConfig: JSON.parse(field.config_json) as JsonValue,
    fieldType: field.field_type
  };
  const leftIndex = definition.toIndex(definition.normalize(left, context).value, context);
  const rightIndex = definition.toIndex(definition.normalize(right, context).value, context);
  const leftEmpty =
    leftIndex.numberValue == null &&
    leftIndex.boolValue == null &&
    leftIndex.datetimeValue == null &&
    (leftIndex.textValue == null || leftIndex.textValue === "");
  const rightEmpty =
    rightIndex.numberValue == null &&
    rightIndex.boolValue == null &&
    rightIndex.datetimeValue == null &&
    (rightIndex.textValue == null || rightIndex.textValue === "");

  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) {
      return 0;
    }

    return leftEmpty ? 1 : -1;
  }

  let comparison = 0;
  if (leftIndex.numberValue != null && rightIndex.numberValue != null) {
    comparison = Number(leftIndex.numberValue) - Number(rightIndex.numberValue);
  } else if (leftIndex.boolValue != null && rightIndex.boolValue != null) {
    comparison = leftIndex.boolValue === rightIndex.boolValue ? 0 : leftIndex.boolValue ? 1 : -1;
  } else if (leftIndex.datetimeValue != null && rightIndex.datetimeValue != null) {
    comparison =
      leftIndex.datetimeValue === rightIndex.datetimeValue
        ? 0
        : leftIndex.datetimeValue < rightIndex.datetimeValue
          ? -1
          : 1;
  } else {
    const leftText = (leftIndex.textValue ?? "").toLowerCase();
    const rightText = (rightIndex.textValue ?? "").toLowerCase();
    comparison =
      leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
    if (comparison === 0) {
      comparison =
        leftIndex.textValue === rightIndex.textValue
          ? 0
          : (leftIndex.textValue ?? "") < (rightIndex.textValue ?? "")
            ? -1
            : 1;
    }
  }

  if (comparison === 0) {
    return 0;
  }

  switch (mode) {
    case "descending":
    case "true_first":
      return comparison > 0 ? -1 : 1;
    case "ascending":
    case "false_first":
    default:
      return comparison > 0 ? 1 : -1;
  }
}

function evaluateFilterDefinition(
  workflowOperatorRegistry: WorkflowOperatorRegistry,
  filter: ViewFilterDefinition,
  value: unknown
): boolean {
  const operator = workflowOperatorRegistry.get(filter.operatorId);
  if (!operator || operator.kind !== "condition") {
    return false;
  }

  switch (filter.operatorId) {
    case "equals":
    case "not_equals":
      return operator.evaluate({
        left: value,
        right: filter.value
      });
    case "is_empty":
    case "is_not_empty":
      return operator.evaluate({
        value
      });
    case "text_contains":
      return operator.evaluate({
        query: filter.value,
        value
      });
    case "text_starts_with":
      return operator.evaluate({
        prefix: filter.value,
        value
      });
    case "number_compare":
      return operator.evaluate({
        comparator: filter.comparator,
        left: value,
        right: filter.value
      });
    case "date_compare":
      return operator.evaluate({
        comparator: filter.comparator,
        left: value,
        right: filter.value
      });
    case "select_has_option":
      return operator.evaluate({
        option: filter.value,
        value
      });
    case "relation_contains_record":
      return operator.evaluate({
        recordId: filter.value,
        value
      });
    default:
      return false;
  }
}

function buildFilterMetadata(
  schema: ParsedViewSchema,
  snapshot: EffectivePermissionSnapshot | undefined,
  permissionedFieldIds: ReadonlySet<string>
): Array<ViewFilterDefinition & { protected: boolean }> {
  return schema.filters.map((filter) => {
    const readState = snapshot?.fields[filter.fieldId]?.read ?? "visible";
    const protectedFilter = !permissionedFieldIds.has(filter.fieldId) || readState !== "visible";

    if (!protectedFilter) {
      return {
        ...filter,
        protected: false
      };
    }

    return {
      fieldId: filter.fieldId,
      operatorId: filter.operatorId,
      comparator: filter.comparator,
      protected: true
    };
  });
}

export async function readViewQuery(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  viewPlanner: ViewPlanner,
  workflowOperatorRegistry: WorkflowOperatorRegistry,
  input: ReadViewQueryInput
): Promise<ReadViewQueryResult | null> {
  const view = await db
    .prepare(
      `SELECT id, table_id, view_key, name, current_schema_version
       FROM views
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.tableId, input.viewId)
    .first<ViewRow>();

  if (!view) {
    return null;
  }

  const viewSchemaRow = await db
    .prepare(
      `SELECT schema_json
       FROM view_schema_versions
       WHERE workspace_id = ? AND view_id = ? AND schema_version = ?`
    )
    .bind(input.workspaceId, view.id, view.current_schema_version)
    .first<ViewSchemaRow>();

  if (!viewSchemaRow) {
    return null;
  }

  const schema = parseViewSchema(viewSchemaRow.schema_json);
  const snapshot =
    input.snapshot ??
    (await readPermissionSnapshot(db, {
      permissionScopeHash: input.permissionScopeHash,
      policyRevision: input.policyRevision,
      principalId: input.principalId,
      workspaceId: input.workspaceId
    }));
  const fieldRows = await db
    .prepare(
      `SELECT id, field_key, field_type, label
             , config_json
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL
       ORDER BY field_key ASC, id ASC`
    )
    .bind(input.workspaceId, input.tableId)
    .all<FieldRow>();
  const fieldIndex = new Map((fieldRows.results ?? []).map((field) => [field.id, field]));

  const selectedFields =
    schema.visibleFieldIds.length > 0
      ? schema.visibleFieldIds
          .map((fieldId) => fieldIndex.get(fieldId))
          .filter((field): field is FieldRow => Boolean(field))
      : (fieldRows.results ?? []);
  const executionFields = Array.from(
    new Map(
      [
        ...selectedFields,
        ...schema.filterFieldIds
          .map((fieldId) => fieldIndex.get(fieldId))
          .filter((field): field is FieldRow => Boolean(field)),
        ...schema.sortFieldIds
          .map((fieldId) => fieldIndex.get(fieldId))
          .filter((field): field is FieldRow => Boolean(field)),
        ...(schema.groupByFieldId ? [fieldIndex.get(schema.groupByFieldId)] : []).filter(
          (field): field is FieldRow => Boolean(field)
        )
      ].map((field) => [field.id, field] as const)
    ).values()
  );
  const constraints: ViewQueryConstraint[] = [
    ...schema.sorts
      .map((sort) => fieldIndex.get(sort.fieldId))
      .filter((field): field is FieldRow => Boolean(field))
      .map((field) => ({
        fieldId: field.id,
        fieldType: field.field_type,
        kind: "sort" as const
      })),
    ...((schema.groupByFieldId ? [fieldIndex.get(schema.groupByFieldId)] : [])
      .filter((field): field is FieldRow => Boolean(field))
      .map((field) => ({
        fieldId: field.id,
        fieldType: field.field_type,
        kind: "group" as const
      })) satisfies ViewQueryConstraint[])
  ];
  const filterConstraints: ViewQueryConstraint[] = schema.filters
    .map((filter) => fieldIndex.get(filter.fieldId))
    .filter((field): field is FieldRow => Boolean(field))
    .map((field) => ({
      fieldId: field.id,
      fieldType: field.field_type,
      kind: "filter" as const
    }));
  const filterBlockedFieldIds = new Set<string>();
  const filterDiagnostics = new Set<string>();
  for (const filter of schema.filters) {
    const field = fieldIndex.get(filter.fieldId);
    if (!field) {
      filterBlockedFieldIds.add(filter.fieldId);
      filterDiagnostics.add(`view_unknown_field:${filter.fieldId}`);
      continue;
    }

    const fieldDescription = viewPlanner.describeField(field.field_type);
    if (!fieldDescription.capabilities.supportsFiltering) {
      filterBlockedFieldIds.add(filter.fieldId);
      filterDiagnostics.add(`view_filter_unsupported:${filter.fieldId}`);
      continue;
    }

    if (!fieldDescription.supportedConditionOperators.includes(filter.operatorId)) {
      filterBlockedFieldIds.add(filter.fieldId);
      filterDiagnostics.add(`view_filter_operator_unsupported:${filter.fieldId}:${filter.operatorId}`);
    }
  }

  const executionPlan = viewPlanner.planQuery(
    executionFields.map((field) => ({
      fieldId: field.id,
      fieldType: field.field_type
    })),
    constraints,
    snapshot
  );
  const surfacePlan = viewPlanner.planQuery(
    selectedFields.map((field) => ({
      fieldId: field.id,
      fieldType: field.field_type
    })),
    [],
    snapshot
  );

  const fields = selectedFields.map((field) => ({
    fieldId: field.id,
    fieldKey: field.field_key,
    fieldType: field.field_type,
    label: field.label
  }));
  const blockedFieldIds = Array.from(
    new Set([...executionPlan.blockedFieldIds, ...Array.from(filterBlockedFieldIds)])
  );
  const viewDiagnostics = Array.from(
    new Set([...surfacePlan.diagnostics, ...executionPlan.diagnostics, ...Array.from(filterDiagnostics)])
  );

  if (blockedFieldIds.length > 0) {
    return {
      fields,
      rows: [],
      view: {
        allowed: false,
        blockedFieldIds,
        consistencyModel: "view_eventual",
        deniedFieldIds: surfacePlan.hiddenFieldIds,
        diagnostics: viewDiagnostics,
        filters: buildFilterMetadata(
          schema,
          snapshot,
          new Set(filterConstraints.map((constraint) => constraint.fieldId))
        ),
        redactedFieldIds: surfacePlan.redactedFieldIds,
        redactionApplied: surfacePlan.redactionApplied,
        tableId: view.table_id,
        viewId: view.id,
        viewKey: view.view_key,
        viewName: view.name,
        viewSchemaVersion: view.current_schema_version,
        visibleFieldIds: surfacePlan.visibleFieldIds
      }
    };
  }

  const recordQuery = buildViewRecordQuery(input, schema);
  const recordRows = await db
    .prepare(recordQuery.sql)
    .bind(...recordQuery.bindings)
    .all<RecordProjectionRow>();
  const comparisonFields = Array.from(
    new Map(
      [
        ...schema.sorts
          .map((sort) => fieldIndex.get(sort.fieldId))
          .filter((field): field is FieldRow => Boolean(field)),
        ...(schema.groupByFieldId ? [fieldIndex.get(schema.groupByFieldId)] : []).filter(
          (field): field is FieldRow => Boolean(field)
        )
      ].map((field) => [field.id, field] as const)
    ).values()
  );
  const filterFields = Array.from(
    new Map(
      schema.filters
        .map((filter) => fieldIndex.get(filter.fieldId))
        .filter((field): field is FieldRow => Boolean(field))
        .map((field) => [field.id, field] as const)
    ).values()
  );
  const visibleFilterFieldIds = new Set(
    snapshot
      ? filterConstraints
          .map((constraint) =>
            snapshot.fields[constraint.fieldId]?.read === "visible" ? constraint.fieldId : null
          )
          .filter((fieldId): fieldId is string => fieldId !== null)
      : filterConstraints.map((constraint) => constraint.fieldId)
  );

  const materializedRows = (recordRows.results ?? []).map((row) => {
    const projection = JSON.parse(row.projection_json) as {
      fields?: Record<string, unknown>;
    };
    const selectedInputs: PermissionProjectionInput[] = selectedFields.map((field) => ({
      fieldConfig: JSON.parse(field.config_json),
      fieldId: field.id,
      fieldType: field.field_type,
      value: projection.fields?.[field.field_key] ?? null
    }));
    const projected = viewPlanner.projectRow(selectedInputs, snapshot);
    const comparisonInputs: PermissionProjectionInput[] = comparisonFields.map((field) => ({
      fieldConfig: JSON.parse(field.config_json),
      fieldId: field.id,
      fieldType: field.field_type,
      value: projection.fields?.[field.field_key] ?? null
    }));
    const filterInputs: PermissionProjectionInput[] = filterFields.map((field) => ({
      fieldConfig: JSON.parse(field.config_json),
      fieldId: field.id,
      fieldType: field.field_type,
      value: projection.fields?.[field.field_key] ?? null
    }));
    const groupField =
      schema.groupByFieldId != null ? fieldIndex.get(schema.groupByFieldId) ?? null : null;
    const groupFieldValue =
      groupField != null ? projection.fields?.[groupField.field_key] ?? null : null;
    const groupFieldDefinition =
      groupField != null ? fieldTypeRegistry.require(groupField.field_type) : null;
    const groupNormalized =
      groupField != null && groupFieldDefinition != null
        ? groupFieldDefinition.normalize(groupFieldValue, {
            fieldConfig: JSON.parse(groupField.config_json),
            fieldType: groupField.field_type
          }).value
        : null;
    const groupIndexValue =
      groupField != null && groupFieldDefinition != null
        ? groupFieldDefinition.toIndex(groupNormalized, {
            fieldConfig: JSON.parse(groupField.config_json),
            fieldType: groupField.field_type
          })
        : null;

    return {
      comparisonInputs,
      filterInputs,
      groupBucketKey: groupIndexValue?.valueHash ?? "null",
      groupLabel: groupIndexValue?.displayValue ?? "",
      recordId: row.record_id,
      recordKey: row.record_key,
      row: {
        cells: projected.fields,
        hiddenFieldIds: projected.hiddenFieldIds,
        recordId: row.record_id,
        recordKey: row.record_key,
        redactedFieldIds: projected.redactedFieldIds,
        states: projected.states
      }
    } satisfies MaterializedViewRow;
  });
  const filteredRows = materializedRows.filter((row) =>
    schema.filters.every((filter) => {
      const inputForFilter = row.filterInputs.find((input) => input.fieldId === filter.fieldId);
      return evaluateFilterDefinition(
        workflowOperatorRegistry,
        filter,
        inputForFilter?.value ?? null
      );
    })
  );
  const sortedMaterializedRows = [...filteredRows].sort((left, right) => {
    for (const sort of schema.sorts) {
      const field = fieldIndex.get(sort.fieldId);
      if (!field) {
        continue;
      }

      const leftValue = left.comparisonInputs.find((input) => input.fieldId === sort.fieldId)?.value ?? null;
      const rightValue = right.comparisonInputs.find((input) => input.fieldId === sort.fieldId)?.value ?? null;
      const comparison = compareSortValues(
        fieldTypeRegistry,
        field,
        leftValue,
        rightValue,
        sort.mode
      );
      if (comparison !== 0) {
        return comparison;
      }
    }

    if (left.recordKey !== right.recordKey) {
      return left.recordKey < right.recordKey ? -1 : 1;
    }

    if (left.recordId === right.recordId) {
      return 0;
    }

    return left.recordId < right.recordId ? -1 : 1;
  });
  const rows = sortedMaterializedRows.map((row) => row.row);

  if (!schema.groupByFieldId) {
    return {
      fields,
      rows,
      view: {
        allowed: true,
        blockedFieldIds: [],
        consistencyModel: "view_eventual",
        deniedFieldIds: surfacePlan.hiddenFieldIds,
        diagnostics: viewDiagnostics,
        filters: buildFilterMetadata(schema, snapshot, visibleFilterFieldIds),
        redactedFieldIds: surfacePlan.redactedFieldIds,
        redactionApplied: rows.some((row) => row.redactedFieldIds.length > 0),
        tableId: view.table_id,
        viewId: view.id,
        viewKey: view.view_key,
        viewName: view.name,
        viewSchemaVersion: view.current_schema_version,
        visibleFieldIds: surfacePlan.visibleFieldIds
      }
    };
  }

  const sortedRows = [...filteredRows].sort((left, right) => {
    const groupComparison = viewPlanner.compareRows(
      left.comparisonInputs,
      right.comparisonInputs,
      [schema.groupByFieldId!]
    );
    if (groupComparison !== 0) {
      return groupComparison;
    }

    const rowComparison = viewPlanner.compareRows(
      left.comparisonInputs,
      right.comparisonInputs,
      schema.sortFieldIds
    );
    if (rowComparison !== 0) {
      return rowComparison;
    }

    if (left.recordKey !== right.recordKey) {
      return left.recordKey < right.recordKey ? -1 : 1;
    }

    if (left.recordId === right.recordId) {
      return 0;
    }

    return left.recordId < right.recordId ? -1 : 1;
  });
  const groups: ViewQueryGroupResult[] = [];
  for (const row of sortedRows) {
    const currentGroup = groups.at(-1);

    if (!currentGroup || currentGroup.bucketKey !== row.groupBucketKey) {
      groups.push({
        bucketKey: row.groupBucketKey,
        groupLabel: row.groupLabel,
        rowCount: 1,
        rows: [row.row]
      });
      continue;
    }

    currentGroup.rows.push(row.row);
    currentGroup.rowCount += 1;
  }

  return {
    fields,
    groups,
    rows: [],
    view: {
      allowed: true,
      blockedFieldIds: [],
      consistencyModel: "view_eventual",
      deniedFieldIds: surfacePlan.hiddenFieldIds,
      diagnostics: viewDiagnostics,
      filters: buildFilterMetadata(schema, snapshot, visibleFilterFieldIds),
      redactedFieldIds: surfacePlan.redactedFieldIds,
      redactionApplied: rows.some((row) => row.redactedFieldIds.length > 0),
      tableId: view.table_id,
      viewId: view.id,
      viewKey: view.view_key,
      viewName: view.name,
      viewSchemaVersion: view.current_schema_version,
      visibleFieldIds: surfacePlan.visibleFieldIds
    }
  };
}
