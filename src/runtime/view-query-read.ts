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

type FieldIndexEntryRow = {
  field_id: string;
  index_value_bool: number | null;
  index_value_datetime: string | null;
  index_value_number: number | null;
  index_value_text: string | null;
  record_id: string;
};

type ParsedViewSchema = {
  filterFieldIds: string[];
  filters: ViewFilterDefinition[];
  groupByFieldId: string | null;
  showEmptyGroups: boolean;
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
    actions?: {
      createRecord: {
        allowed: boolean;
        constrainedFieldIds: string[];
        defaultCells: Record<string, JsonValue>;
        fieldId: string | null;
        fieldType: string | null;
        reasons: string[];
        requiresGroupValue: boolean;
        status: "writable" | "read_only" | "hidden" | "denied";
      };
      groupMove: {
        allowed: boolean;
        fieldId: string | null;
        fieldType: string | null;
        reasons: string[];
        status: "writable" | "read_only" | "hidden" | "denied";
      };
    };
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
  groupValue?: JsonValue;
  rowCount: number;
  rows: ViewQueryRowResult[];
};

type ConfiguredGroupBucket = {
  bucketKey: string;
  groupLabel: string;
};

type ViewRecordQuery = {
  bindings: unknown[];
  sql: string;
};

type MaterializedViewRow = {
  filterInputs: PermissionProjectionInput[];
  groupBucketKey: string;
  groupLabel: string;
  groupValue: JsonValue;
  indexedValues: Map<string, IndexedFieldValue>;
  recordId: string;
  recordKey: string;
  row: ViewQueryRowResult;
  sortInputs: PermissionProjectionInput[];
};

type IndexedFieldValue = {
  boolValue: boolean | null;
  datetimeValue: string | null;
  numberValue: number | null;
  textValue: string | null;
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
    showEmptyGroups: parsed.showEmptyGroups === true,
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

function listConfiguredGroupBuckets(field: FieldRow | null): ConfiguredGroupBucket[] {
  if (
    field == null ||
    (field.field_type !== "select.single" && field.field_type !== "status.semantic")
  ) {
    return [];
  }

  const parsedConfig = JSON.parse(field.config_json) as Record<string, unknown>;
  if (!Array.isArray(parsedConfig.options)) {
    return [];
  }

  return parsedConfig.options.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry == null ||
      Array.isArray(entry) ||
      typeof entry.id !== "string"
    ) {
      return [];
    }

    return [
      {
        bucketKey: JSON.stringify(entry.id),
        groupLabel: typeof entry.label === "string" ? entry.label : entry.id
      }
    ];
  });
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

function compareIndexedSortValues(
  left: IndexedFieldValue | null,
  right: IndexedFieldValue | null,
  mode: string
): number {
  const leftEmpty =
    left == null ||
    (left.numberValue == null &&
      left.boolValue == null &&
      left.datetimeValue == null &&
      (left.textValue == null || left.textValue === ""));
  const rightEmpty =
    right == null ||
    (right.numberValue == null &&
      right.boolValue == null &&
      right.datetimeValue == null &&
      (right.textValue == null || right.textValue === ""));

  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) {
      return 0;
    }

    return leftEmpty ? 1 : -1;
  }

  let comparison = 0;
  if (left.numberValue != null && right.numberValue != null) {
    comparison = left.numberValue - right.numberValue;
  } else if (left.boolValue != null && right.boolValue != null) {
    comparison = left.boolValue === right.boolValue ? 0 : left.boolValue ? 1 : -1;
  } else if (left.datetimeValue != null && right.datetimeValue != null) {
    comparison =
      left.datetimeValue === right.datetimeValue
        ? 0
        : left.datetimeValue < right.datetimeValue
          ? -1
          : 1;
  } else {
    const leftText = (left.textValue ?? "").toLowerCase();
    const rightText = (right.textValue ?? "").toLowerCase();
    comparison = leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
    if (comparison === 0) {
      comparison =
        left.textValue === right.textValue
          ? 0
          : (left.textValue ?? "") < (right.textValue ?? "")
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

function indexedValueForField(
  field: FieldRow,
  indexValue: IndexedFieldValue | null,
  projectedValue: unknown
): unknown {
  if (indexValue == null) {
    return projectedValue;
  }

  switch (field.field_type) {
    case "number.decimal":
      return indexValue.numberValue ?? projectedValue;
    case "boolean.checkbox":
      return indexValue.boolValue ?? projectedValue;
    case "date.datetime":
    case "date.date":
      return indexValue.datetimeValue ?? indexValue.textValue ?? projectedValue;
    default:
      return (
        indexValue.textValue ??
        indexValue.datetimeValue ??
        indexValue.numberValue ??
        indexValue.boolValue ??
        projectedValue
      );
  }
}

function compareMaterializedRowsBySorts(
  input: {
    fieldIndex: ReadonlyMap<string, FieldRow>;
    fieldTypeRegistry: FieldTypeRegistry;
    left: MaterializedViewRow;
    right: MaterializedViewRow;
    sorts: readonly ViewSortDefinition[];
  }
): number {
  for (const sort of input.sorts) {
    const field = input.fieldIndex.get(sort.fieldId);
    if (!field) {
      continue;
    }

    const leftIndexValue = input.left.indexedValues.get(sort.fieldId) ?? null;
    const rightIndexValue = input.right.indexedValues.get(sort.fieldId) ?? null;
    const comparison =
      leftIndexValue != null || rightIndexValue != null
        ? compareIndexedSortValues(leftIndexValue, rightIndexValue, sort.mode)
        : compareSortValues(
            input.fieldTypeRegistry,
            field,
            input.left.sortInputs.find((sortInput) => sortInput.fieldId === sort.fieldId)?.value ?? null,
            input.right.sortInputs.find((sortInput) => sortInput.fieldId === sort.fieldId)?.value ?? null,
            sort.mode
          );

    if (comparison !== 0) {
      return comparison;
    }
  }

  if (input.left.recordKey !== input.right.recordKey) {
    return input.left.recordKey < input.right.recordKey ? -1 : 1;
  }

  if (input.left.recordId === input.right.recordId) {
    return 0;
  }

  return input.left.recordId < input.right.recordId ? -1 : 1;
}

async function loadFieldIndexEntries(
  db: D1Database,
  input: {
    fieldIds: readonly string[];
    tableId: string;
    workspaceId: string;
  }
): Promise<Map<string, Map<string, IndexedFieldValue>>> {
  if (input.fieldIds.length === 0) {
    return new Map();
  }

  const placeholders = input.fieldIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT
         record_id,
         field_id,
         index_value_text,
         index_value_number,
         index_value_datetime,
         index_value_bool
       FROM field_index_entries
       WHERE workspace_id = ?
         AND table_id = ?
         AND field_id IN (${placeholders})`
    )
    .bind(input.workspaceId, input.tableId, ...input.fieldIds)
    .all<FieldIndexEntryRow>();

  const byRecordId = new Map<string, Map<string, IndexedFieldValue>>();
  for (const row of rows.results ?? []) {
    let recordFields = byRecordId.get(row.record_id);
    if (!recordFields) {
      recordFields = new Map();
      byRecordId.set(row.record_id, recordFields);
    }

    recordFields.set(row.field_id, {
      boolValue: row.index_value_bool == null ? null : Boolean(row.index_value_bool),
      datetimeValue: row.index_value_datetime,
      numberValue: row.index_value_number,
      textValue: row.index_value_text
    });
  }

  return byRecordId;
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

function buildGroupMoveAffordance(
  groupField: FieldRow | null,
  schema: ParsedViewSchema,
  viewPlanner: ViewPlanner,
  snapshot: EffectivePermissionSnapshot | undefined
): NonNullable<ReadViewQueryResult["view"]["actions"]>["groupMove"] {
  if (!schema.groupByFieldId || !groupField) {
    return {
      allowed: false,
      fieldId: schema.groupByFieldId ?? null,
      fieldType: groupField?.field_type ?? null,
      reasons: ["view_group_move_unavailable"],
      status: "denied"
    };
  }

  const fieldConfig = JSON.parse(groupField.config_json);
  const readState = snapshot?.fields[groupField.id]?.read ?? "visible";
  if (readState !== "visible") {
    return {
      allowed: false,
      fieldId: groupField.id,
      fieldType: groupField.field_type,
      reasons: [`view_group_field_${readState}:${groupField.id}`],
      status: "hidden"
    };
  }

  const plan = viewPlanner.planQuery(
    [
      {
        fieldConfig,
        fieldId: groupField.id,
        fieldType: groupField.field_type
      }
    ],
    [
      {
        fieldConfig,
        fieldId: groupField.id,
        fieldType: groupField.field_type,
        kind: "group"
      }
    ],
    snapshot
  );
  if (!plan.allowed) {
    return {
      allowed: false,
      fieldId: groupField.id,
      fieldType: groupField.field_type,
      reasons: plan.diagnostics,
      status: "denied"
    };
  }

  const writeAllowed = snapshot?.fields[groupField.id]?.write ?? true;
  if (!writeAllowed) {
    return {
      allowed: false,
      fieldId: groupField.id,
      fieldType: groupField.field_type,
      reasons: [`field_read_only:${groupField.id}`],
      status: "read_only"
    };
  }

  return {
    allowed: true,
    fieldId: groupField.id,
    fieldType: groupField.field_type,
    reasons: [],
    status: "writable"
  };
}

function buildCreateRecordAffordance(
  fieldIndex: ReadonlyMap<string, FieldRow>,
  schema: ParsedViewSchema,
  viewPlanner: ViewPlanner,
  snapshot: EffectivePermissionSnapshot | undefined
): NonNullable<ReadViewQueryResult["view"]["actions"]>["createRecord"] {
  const reasons = new Set<string>();
  const defaultCells = new Map<string, JsonValue>();
  const constrainedFieldIds = new Set<string>();
  let status: "writable" | "read_only" | "hidden" | "denied" = "writable";
  const groupField = schema.groupByFieldId ? fieldIndex.get(schema.groupByFieldId) ?? null : null;

  const tightenStatus = (next: typeof status) => {
    const rank = {
      writable: 0,
      denied: 1,
      read_only: 2,
      hidden: 3
    } as const;
    if (rank[next] > rank[status]) {
      status = next;
    }
  };

  const registerFieldAccess = (field: FieldRow, kind: "filter" | "group") => {
    const readState = snapshot?.fields[field.id]?.read ?? "visible";
    if (readState !== "visible") {
      reasons.add(`view_create_${kind}_field_${readState}:${field.id}`);
      tightenStatus("hidden");
      return;
    }

    const fieldConfig = JSON.parse(field.config_json);
    const plan = viewPlanner.planQuery(
      [
        {
          fieldConfig,
          fieldId: field.id,
          fieldType: field.field_type
        }
      ],
      [
        {
          fieldConfig,
          fieldId: field.id,
          fieldType: field.field_type,
          kind
        }
      ],
      snapshot
    );
    if (!plan.allowed) {
      for (const diagnostic of plan.diagnostics) {
        reasons.add(diagnostic);
      }
      tightenStatus("denied");
      return;
    }

    const writeAllowed = snapshot?.fields[field.id]?.write ?? true;
    if (!writeAllowed) {
      reasons.add(`field_read_only:${field.id}`);
      tightenStatus("read_only");
    }
  };

  const registerDefault = (fieldId: string, value: JsonValue, reason: string) => {
    constrainedFieldIds.add(fieldId);
    if (!defaultCells.has(fieldId)) {
      defaultCells.set(fieldId, value);
      return;
    }

    if (JSON.stringify(defaultCells.get(fieldId)) !== JSON.stringify(value)) {
      reasons.add(reason);
      tightenStatus("denied");
    }
  };

  for (const filter of schema.filters) {
    const field = fieldIndex.get(filter.fieldId);
    if (!field) {
      reasons.add(`view_unknown_field:${filter.fieldId}`);
      tightenStatus("denied");
      continue;
    }

    registerFieldAccess(field, "filter");
    switch (filter.operatorId) {
      case "equals":
        registerDefault(field.id, (filter.value ?? null) as JsonValue, `view_create_filter_conflict:${field.id}`);
        break;
      case "is_empty":
        registerDefault(field.id, null, `view_create_filter_conflict:${field.id}`);
        break;
      default:
        reasons.add(`view_create_filter_operator_unsupported:${field.id}:${filter.operatorId}`);
        tightenStatus("denied");
        break;
    }
  }

  if (groupField) {
    constrainedFieldIds.add(groupField.id);
    registerFieldAccess(groupField, "group");
  }

  return {
    allowed: status === "writable",
    constrainedFieldIds: Array.from(constrainedFieldIds),
    defaultCells: Object.fromEntries(defaultCells),
    fieldId: groupField?.id ?? null,
    fieldType: groupField?.field_type ?? null,
    reasons: Array.from(reasons),
    requiresGroupValue: groupField != null,
    status
  };
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
       ORDER BY
         CASE WHEN field_order IS NULL THEN 0 ELSE 1 END ASC,
         CASE WHEN field_order IS NULL THEN created_at ELSE NULL END ASC,
         CASE WHEN field_order IS NULL THEN id ELSE NULL END ASC,
         field_order ASC,
         id ASC`
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
  const groupField =
    schema.groupByFieldId != null ? fieldIndex.get(schema.groupByFieldId) ?? null : null;
  const createRecord = buildCreateRecordAffordance(fieldIndex, schema, viewPlanner, snapshot);
  const groupMove = buildGroupMoveAffordance(groupField, schema, viewPlanner, snapshot);
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
        actions: {
          createRecord,
          groupMove: buildGroupMoveAffordance(groupField, schema, viewPlanner, snapshot)
        },
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
  const indexedFieldValues = await loadFieldIndexEntries(db, {
    fieldIds: Array.from(
      new Set([
        ...schema.filterFieldIds,
        ...schema.sortFieldIds,
        ...(schema.groupByFieldId ? [schema.groupByFieldId] : [])
      ])
    ),
    tableId: input.tableId,
    workspaceId: input.workspaceId
  });
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
    const recordIndexValues = indexedFieldValues.get(row.record_id) ?? new Map<string, IndexedFieldValue>();
    const selectedInputs: PermissionProjectionInput[] = selectedFields.map((field) => ({
      fieldConfig: JSON.parse(field.config_json),
      fieldId: field.id,
      fieldType: field.field_type,
      value: projection.fields?.[field.field_key] ?? null
    }));
    const projected = viewPlanner.projectRow(selectedInputs, snapshot);
    const filterInputs: PermissionProjectionInput[] = filterFields.map((field) => ({
      fieldConfig: JSON.parse(field.config_json),
      fieldId: field.id,
      fieldType: field.field_type,
      value:
        indexedValueForField(
          field,
          recordIndexValues.get(field.id) ?? null,
          projection.fields?.[field.field_key] ?? null
        ) ?? null
    }));
    const sortInputs: PermissionProjectionInput[] = comparisonFields.map((field) => ({
      fieldConfig: JSON.parse(field.config_json),
      fieldId: field.id,
      fieldType: field.field_type,
      value:
        indexedValueForField(
          field,
          recordIndexValues.get(field.id) ?? null,
          projection.fields?.[field.field_key] ?? null
        ) ?? null
    }));
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
      filterInputs,
      groupBucketKey: groupIndexValue?.valueHash ?? "null",
      groupLabel: groupIndexValue?.displayValue ?? "",
      groupValue: (groupNormalized?.raw ?? null) as JsonValue,
      indexedValues: recordIndexValues,
      recordId: row.record_id,
      recordKey: row.record_key,
      row: {
        cells: projected.fields,
        hiddenFieldIds: projected.hiddenFieldIds,
        recordId: row.record_id,
        recordKey: row.record_key,
        redactedFieldIds: projected.redactedFieldIds,
        states: projected.states
      },
      sortInputs
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
    return compareMaterializedRowsBySorts({
      fieldIndex,
      fieldTypeRegistry,
      left,
      right,
      sorts: schema.sorts
    });
  });
  const rows = sortedMaterializedRows.map((row) => row.row);

  if (!schema.groupByFieldId) {
    return {
      fields,
      rows,
      view: {
        actions: {
          createRecord,
          groupMove
        },
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
    const groupComparison = compareMaterializedRowsBySorts({
      fieldIndex,
      fieldTypeRegistry,
      left,
      right,
      sorts: [
        {
          fieldId: schema.groupByFieldId!,
          mode: "ascending"
        }
      ]
    });
    if (groupComparison !== 0) {
      return groupComparison;
    }

    const rowComparison = compareMaterializedRowsBySorts({
      fieldIndex,
      fieldTypeRegistry,
      left,
      right,
      sorts: schema.sorts
    });
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
        groupValue: row.groupValue,
        rowCount: 1,
        rows: [row.row]
      });
      continue;
    }

    currentGroup.rows.push(row.row);
    currentGroup.rowCount += 1;
  }

  const configuredGroups =
    schema.showEmptyGroups && groupField != null ? listConfiguredGroupBuckets(groupField) : [];
  const mergedGroups =
    configuredGroups.length === 0
      ? groups
      : (() => {
          const remaining = new Map(groups.map((group) => [group.bucketKey, group]));
          const ordered: ViewQueryGroupResult[] = [];

          for (const configuredGroup of configuredGroups) {
            ordered.push(
              remaining.get(configuredGroup.bucketKey) ?? {
                bucketKey: configuredGroup.bucketKey,
                groupLabel: configuredGroup.groupLabel,
                rowCount: 0,
                rows: []
              }
            );
            remaining.delete(configuredGroup.bucketKey);
          }

          for (const group of groups) {
            if (remaining.has(group.bucketKey)) {
              ordered.push(group);
            }
          }

          return ordered;
        })();

  return {
    fields,
    groups: mergedGroups,
    rows: [],
    view: {
      actions: {
        createRecord,
        groupMove
      },
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
