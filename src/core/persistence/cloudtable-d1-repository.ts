import { createFieldTypeRegistry } from "../field-types/registry";
import type {
  FieldIndexValue,
  FieldTypeRegistry,
  JsonValue,
  NormalizedCellValue
} from "../field-types/types";
import { CommandCommitError } from "../commands/errors";
import { isSupportedDomainCommandType } from "../commands/domain";
import { toCanonicalJson } from "../commands/transcript";
import type { IdempotencyReceipt } from "../commands/types";
import type { EventLedgerCommit, EventLedgerRecord } from "../events/types";
import { createWorkflowOperatorRegistry } from "../workflows/operator-registry";
import type {
  WorkflowActionBinding,
  WorkflowConditionBinding,
  WorkflowDefinition,
  WorkflowTriggerBinding
} from "../workflows/types";
import type { CloudTableRepository, OutboxRow, ReceiptRow } from "./types";

type SequenceRow = {
  nextSequence: number;
};

type AppRow = {
  id: string;
};

type TableRow = {
  app_id: string;
  current_schema_version: number;
  id: string;
  schema_epoch: number;
};

type FieldRow = {
  config_json: string;
  field_key: string;
  field_type: string;
  field_type_version: number;
  id: string;
  label: string;
};

type ViewRow = {
  current_schema_version: number;
  id: string;
  view_key: string;
};

type RecordStateRow = {
  last_event_id: string | null;
  record_key: string;
  record_revision: number;
};

type CellStateRow = {
  bool_value?: number | null;
  cell_revision: number;
  datetime_value?: string | null;
  display_value: string;
  field_id: string;
  field_key: string;
  number_value?: number | null;
  reference_value?: string | null;
  search_text?: string;
  text_value?: string | null;
  value_hash?: string;
  value_json: string;
  value_type?: string;
  value_version?: number;
};

type WorkflowRow = {
  current_version: number;
  id: string;
};

type WorkflowVersionRow = {
  definition_json: string;
  id: string;
  published_at: string | null;
  version: number;
  workflow_id: string;
};

const workflowOperatorRegistry = createWorkflowOperatorRegistry();

function parseReceipt(row: ReceiptRow): IdempotencyReceipt {
  return JSON.parse(row.receipt_json) as IdempotencyReceipt;
}

function projectionPayloadFromCommit(commit: EventLedgerCommit): {
  projection_json: string;
  record_id: string;
} | null {
  if (isSupportedDomainCommandType(commit.command.commandType)) {
    return null;
  }

  const recordId = commit.command.payload.recordId;
  if (typeof recordId !== "string" || recordId.length === 0 || !commit.command.tableId) {
    return null;
  }

  return {
    projection_json: toCanonicalJson({
      commandId: commit.command.commandId,
      commandType: commit.command.commandType,
      eventId: commit.event.eventId,
      recordId
    }).trimEnd(),
    record_id: recordId
  };
}

function stableRecordKeyFromId(recordId: string): string {
  return recordId.replace(/^rec_/, "record-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asWorkflowDefinition(
  value: unknown
): (WorkflowDefinition & { metadata?: Record<string, unknown> }) | null {
  return isRecord(value) ? (value as WorkflowDefinition & { metadata?: Record<string, unknown> }) : null;
}

function normalizeWorkflowDefinition(
  command: EventLedgerCommit["command"],
  payload: Record<string, unknown>
): WorkflowDefinition & { metadata: Record<string, unknown> } {
  const definition = asWorkflowDefinition(payload.definition) ?? {
    actions: [],
    conditions: [],
    trigger: {
      operatorId: ""
    },
    workflowId: String(payload.workflowId ?? "")
  };
  const metadata = {
    ...(isRecord((definition as { metadata?: unknown }).metadata)
      ? ((definition as { metadata?: Record<string, unknown> }).metadata ?? {})
      : {}),
    status: "draft"
  };

  return {
    actions: Array.isArray(definition.actions) ? definition.actions : [],
    conditions: Array.isArray(definition.conditions) ? definition.conditions : [],
    metadata,
    principal: definition.principal ?? {
      policyRevision: command.permissionsVersion,
      principalId: command.actor.principalId,
      schemaEpoch: command.schemaEpoch,
      scopeHash: command.permissionScopeHash
    },
    trigger: isRecord(definition.trigger)
      ? (definition.trigger as WorkflowTriggerBinding)
      : {
          operatorId: ""
        },
    workflowId: String(payload.workflowId ?? definition.workflowId ?? "")
  };
}

function updateWorkflowStatus(
  definition: WorkflowDefinition & { metadata?: Record<string, unknown> },
  status: "draft" | "published" | "paused"
): WorkflowDefinition & { metadata: Record<string, unknown> } {
  return {
    ...definition,
    metadata: {
      ...(definition.metadata ?? {}),
      status
    }
  };
}

function workflowDefinitionRefs(
  definition: WorkflowDefinition
): Array<{
  configJson: string;
  operatorId: string;
  operatorSlotKey: string;
  operatorVersion: number;
}> {
  const refs: Array<{
    configJson: string;
    operatorId: string;
    operatorSlotKey: string;
    operatorVersion: number;
  }> = [];

  const trigger = workflowOperatorRegistry.require(definition.trigger.operatorId);
  refs.push({
    configJson: toCanonicalJson(definition.trigger).trimEnd(),
    operatorId: trigger.id,
    operatorSlotKey: "trigger",
    operatorVersion: trigger.version
  });

  for (const [index, condition] of definition.conditions.entries()) {
    const operator = workflowOperatorRegistry.require(condition.operatorId);
    refs.push({
      configJson: toCanonicalJson(condition).trimEnd(),
      operatorId: operator.id,
      operatorSlotKey: `condition:${index}`,
      operatorVersion: operator.version
    });
  }

  for (const [index, action] of definition.actions.entries()) {
    const operator = workflowOperatorRegistry.require(action.operatorId);
    refs.push({
      configJson: toCanonicalJson(action).trimEnd(),
      operatorId: operator.id,
      operatorSlotKey: `action:${index}`,
      operatorVersion: operator.version
    });
  }

  return refs;
}

function assertPublishableWorkflowDefinition(definition: WorkflowDefinition): void {
  if (definition.actions.length === 0) {
    throw new CommandCommitError("workflow_actions_missing");
  }

  workflowOperatorRegistry.require(definition.trigger.operatorId);
  for (const condition of definition.conditions as WorkflowConditionBinding[]) {
    workflowOperatorRegistry.require(condition.operatorId);
  }

  for (const action of definition.actions as WorkflowActionBinding[]) {
    const operator = workflowOperatorRegistry.require(action.operatorId);
    if (operator.kind !== "action") {
      throw new CommandCommitError(`workflow_action_wrong_kind:${action.operatorId}`);
    }
    if (!isSupportedDomainCommandType(operator.commandType)) {
      throw new CommandCommitError(`workflow_action_command_unsupported:${operator.commandType}`);
    }
  }
}

function asJsonValue(value: unknown): JsonValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item)) as JsonValue[];
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      asJsonValue(item)
    ]);
    return Object.fromEntries(entries) as JsonValue;
  }

  return null;
}

function isSelectableOptionFieldType(fieldType: string): boolean {
  return (
    fieldType === "select.single" ||
    fieldType === "select.multi" ||
    fieldType === "status.semantic"
  );
}

function parseFieldConfig(raw: string): JsonValue {
  return JSON.parse(raw) as JsonValue;
}

function toNumberValue(indexValue: FieldIndexValue): number | null {
  if (indexValue.numberValue === undefined || indexValue.numberValue === null) {
    return null;
  }

  const parsed = Number(indexValue.numberValue);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getApp(
  db: D1Database,
  workspaceId: string,
  baseId: string
): Promise<AppRow | null> {
  return db
    .prepare(
      `SELECT id
       FROM apps
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, baseId)
    .first<AppRow>();
}

async function getTable(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<TableRow | null> {
  return db
    .prepare(
      `SELECT id, app_id, current_schema_version, schema_epoch
       FROM tables
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId)
    .first<TableRow>();
}

async function getWorkflow(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<WorkflowRow | null> {
  return db
    .prepare(
      `SELECT id, current_version
       FROM workflows
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, workflowId)
    .first<WorkflowRow>();
}

async function getCurrentWorkflowVersion(
  db: D1Database,
  workspaceId: string,
  workflowId: string,
  version: number
): Promise<WorkflowVersionRow | null> {
  return db
    .prepare(
      `SELECT id, workflow_id, version, definition_json, published_at
       FROM workflow_versions
       WHERE workspace_id = ? AND workflow_id = ? AND version = ?`
    )
    .bind(workspaceId, workflowId, version)
    .first<WorkflowVersionRow>();
}

async function getField(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  fieldId: string
): Promise<FieldRow | null> {
  return db
    .prepare(
      `SELECT
         id,
         field_key,
         field_type,
         field_type_version,
         config_json,
         label
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, fieldId)
    .first<FieldRow>();
}

async function getView(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  viewId: string
): Promise<ViewRow | null> {
  return db
    .prepare(
      `SELECT id, view_key, current_schema_version
       FROM views
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, viewId)
    .first<ViewRow>();
}

async function listFields(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<FieldRow[]> {
  const rows = await db
    .prepare(
      `SELECT
         id,
         field_key,
         field_type,
         field_type_version,
         config_json,
         label
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId)
    .all<FieldRow>();

  return rows.results ?? [];
}

type PermissionSnapshotRow = {
  snapshot_json: string;
};

async function getLatestPermissionSnapshot(
  db: D1Database,
  workspaceId: string,
  principalId: string,
  scopeHash: string
): Promise<PermissionSnapshotRow | null> {
  return db
    .prepare(
      `SELECT snapshot_json
       FROM permission_snapshots
       WHERE workspace_id = ? AND principal_id = ? AND scope_hash = ?
       ORDER BY policy_revision DESC
       LIMIT 1`
    )
    .bind(workspaceId, principalId, scopeHash)
    .first<PermissionSnapshotRow>();
}

async function getNextPermissionRevision(db: D1Database, workspaceId: string): Promise<number> {
  const policyRow = await db
    .prepare(
      `SELECT COALESCE(MAX(revision), 0) AS nextSequence
       FROM permission_policies
       WHERE workspace_id = ?`
    )
    .bind(workspaceId)
    .first<SequenceRow>();
  const bindingRow = await db
    .prepare(
      `SELECT COALESCE(MAX(revision), 0) AS nextSequence
       FROM permission_policy_bindings
       WHERE workspace_id = ?`
    )
    .bind(workspaceId)
    .first<SequenceRow>();

  return Math.max(policyRow?.nextSequence ?? 0, bindingRow?.nextSequence ?? 0) + 1;
}

async function getRecord(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  recordId: string
): Promise<RecordStateRow | null> {
  return db
    .prepare(
      `SELECT record_key, record_revision, last_event_id
       FROM records
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, recordId)
    .first<RecordStateRow>();
}

async function getRecordCells(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  recordId: string
): Promise<CellStateRow[]> {
  const rows = await db
    .prepare(
      `SELECT
         cell_current.field_id,
         fields.field_key,
         cell_current.value_json,
         cell_current.display_value,
         cell_current.cell_revision
       FROM cell_current
       INNER JOIN fields
         ON fields.id = cell_current.field_id
       WHERE cell_current.workspace_id = ?
         AND cell_current.table_id = ?
         AND cell_current.record_id = ?
         AND fields.archived_at IS NULL
       ORDER BY fields.field_key ASC`
    )
    .bind(workspaceId, tableId, recordId)
    .all<CellStateRow>();

  return rows.results ?? [];
}

function readViewSchemaPayload(payload: Record<string, unknown>) {
  const visibleFieldIds = Array.isArray(payload.visibleFieldIds)
    ? (payload.visibleFieldIds as string[])
    : [];
  const filters = Array.isArray(payload.filters)
    ? (payload.filters as Array<Record<string, unknown>>)
        .filter(
          (filter) =>
            typeof filter.fieldId === "string" && typeof filter.operatorId === "string"
        )
        .map((filter) => ({
          comparator: typeof filter.comparator === "string" ? filter.comparator : undefined,
          fieldId: filter.fieldId as string,
          operatorId: filter.operatorId as string,
          value: filter.value
        }))
    : [];
  const filterFieldIds =
    filters.length > 0
      ? filters.map((filter) => filter.fieldId)
      : Array.isArray(payload.filterFieldIds)
        ? (payload.filterFieldIds as string[])
        : [];
  const effectiveFilters =
    filters.length > 0
      ? filters
      : filterFieldIds.map((fieldId) => ({
          fieldId,
          operatorId: "is_not_empty"
        }));
  const sorts = Array.isArray(payload.sorts)
    ? (payload.sorts as Array<Record<string, unknown>>)
        .filter((sort) => typeof sort.fieldId === "string")
        .map((sort) => ({
          fieldId: sort.fieldId as string,
          mode: typeof sort.mode === "string" ? sort.mode : undefined
        }))
    : [];
  const sortFieldIds =
    sorts.length > 0
      ? sorts.map((sort) => sort.fieldId)
      : Array.isArray(payload.sortFieldIds)
        ? (payload.sortFieldIds as string[])
        : [];
  const effectiveSorts =
    sorts.length > 0
      ? sorts
      : sortFieldIds.map((fieldId) => ({
          fieldId,
          mode: "ascending"
        }));
  const groupByFieldId =
    typeof payload.groupByFieldId === "string" ? payload.groupByFieldId : null;

  return {
    filterFieldIds,
    filters: effectiveFilters,
    groupByFieldId,
    sortFieldIds,
    sorts: effectiveSorts,
    visibleFieldIds
  };
}

function buildRecordProjection(cells: CellStateRow[]): string {
  const fields = Object.fromEntries(
    cells.map((cell) => {
      const parsed = JSON.parse(cell.value_json) as NormalizedCellValue | null;
      return [cell.field_key, parsed?.raw ?? null];
    })
  );

  return toCanonicalJson({ fields }).trimEnd();
}

async function buildCellMutation(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  workspaceId: string,
  tableId: string,
  fieldId: string,
  value: unknown
): Promise<{
  field: FieldRow;
  normalized: NormalizedCellValue | null;
  index: FieldIndexValue;
}> {
  const field = await getField(db, workspaceId, tableId, fieldId);
  if (!field) {
    throw new CommandCommitError(`field_not_found:${fieldId}`);
  }

  const fieldType = fieldTypeRegistry.require(field.field_type);
  const fieldConfig = parseFieldConfig(field.config_json);
  const normalized = fieldType.normalize(value, {
    fieldConfig,
    fieldType: field.field_type
  }).value;
  const validation = fieldType.validateValue(normalized, {
    fieldConfig,
    fieldType: field.field_type
  });
  if (!validation.valid) {
    throw new CommandCommitError(validation.errors[0] ?? `invalid_field_value:${field.field_type}`);
  }
  const index = fieldType.toIndex(normalized, {
    fieldConfig,
    fieldType: field.field_type
  });

  return {
    field,
    index,
    normalized
  };
}

function buildCellStateRow(
  field: FieldRow,
  normalized: NormalizedCellValue | null,
  index: FieldIndexValue,
  cellRevision: number
): CellStateRow {
  return {
    bool_value:
      index.boolValue === undefined || index.boolValue === null
        ? null
        : index.boolValue
          ? 1
          : 0,
    cell_revision: cellRevision,
    datetime_value: index.datetimeValue ?? null,
    display_value: index.displayValue,
    field_id: field.id,
    field_key: field.field_key,
    number_value: toNumberValue(index),
    reference_value: index.referenceValue ?? null,
    search_text: index.searchText,
    text_value: index.textValue ?? null,
    value_hash: index.valueHash,
    value_json: JSON.stringify(normalized),
    value_type: normalized?.valueType ?? field.field_type,
    value_version: normalized?.version ?? field.field_type_version
  };
}

async function fieldHasDependentIndexes(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  fieldId: string
): Promise<boolean> {
  const views = await db
    .prepare(
      `SELECT view_schema_versions.schema_json
       FROM view_schema_versions
       INNER JOIN views
         ON views.workspace_id = view_schema_versions.workspace_id
        AND views.id = view_schema_versions.view_id
        AND views.current_schema_version = view_schema_versions.schema_version
       WHERE views.workspace_id = ?
         AND views.table_id = ?
         AND views.archived_at IS NULL`
    )
    .bind(workspaceId, tableId)
    .all<{ schema_json: string }>();

  return (views.results ?? []).some((view) => {
    const parsed = JSON.parse(view.schema_json) as {
      filterFieldIds?: unknown;
      groupByFieldId?: unknown;
      sortFieldIds?: unknown;
    };

    return (
      parsed.groupByFieldId === fieldId ||
      (Array.isArray(parsed.filterFieldIds) && parsed.filterFieldIds.includes(fieldId)) ||
      (Array.isArray(parsed.sortFieldIds) && parsed.sortFieldIds.includes(fieldId))
    );
  });
}

async function appendSelectOptionSchemaBackfillStatements(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  workspaceId: string,
  tableId: string,
  field: FieldRow,
  fieldConfig: JsonValue,
  lastEventId: string,
  statements: D1PreparedStatement[]
): Promise<void> {
  const definition = fieldTypeRegistry.require(field.field_type);
  const cellRows = await db
    .prepare(
      `SELECT
         record_id,
         field_id,
         workspace_id,
         table_id,
         value_type,
         value_version,
         value_json,
         text_value,
         number_value,
         bool_value,
         datetime_value,
         reference_value,
         display_value,
         search_text,
         value_hash,
         cell_revision,
         last_event_id
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND field_id = ?
       ORDER BY record_id ASC`
    )
    .bind(workspaceId, tableId, field.id)
    .all<
      CellStateRow & {
        last_event_id: string | null;
        record_id: string;
        table_id: string;
        workspace_id: string;
      }
    >();
  const hasDependentIndexes = await fieldHasDependentIndexes(db, workspaceId, tableId, field.id);

  for (const row of cellRows.results ?? []) {
    const stored = JSON.parse(row.value_json) as NormalizedCellValue | null;
    const nextNormalized = definition.normalize(stored?.raw ?? null, {
      fieldConfig,
      fieldType: field.field_type
    }).value;
    const nextIndex = definition.toIndex(nextNormalized, {
      fieldConfig,
      fieldType: field.field_type
    });
    const nextCell = buildCellStateRow(
      field,
      nextNormalized,
      nextIndex,
      row.cell_revision
    );

    statements.push(
      db
        .prepare(
          `UPDATE cell_current
           SET value_type = ?,
               value_version = ?,
               value_json = ?,
               text_value = ?,
               number_value = ?,
               bool_value = ?,
               datetime_value = ?,
               reference_value = ?,
               display_value = ?,
               search_text = ?,
               value_hash = ?,
               last_event_id = ?
           WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
        )
        .bind(
          nextCell.value_type,
          nextCell.value_version,
          nextCell.value_json,
          nextCell.text_value,
          nextCell.number_value,
          nextCell.bool_value,
          nextCell.datetime_value,
          nextCell.reference_value,
          nextCell.display_value,
          nextCell.search_text,
          nextCell.value_hash,
          lastEventId,
          workspaceId,
          tableId,
          row.record_id,
          field.id
        )
    );

    if (!hasDependentIndexes) {
      statements.push(
        db
          .prepare(
            `DELETE FROM field_index_entries
             WHERE workspace_id = ? AND table_id = ? AND field_id = ? AND record_id = ?`
          )
          .bind(workspaceId, tableId, field.id, row.record_id)
      );
      continue;
    }

    if (nextNormalized == null || nextNormalized.isEmpty) {
      statements.push(
        db
          .prepare(
            `DELETE FROM field_index_entries
             WHERE workspace_id = ? AND table_id = ? AND field_id = ? AND record_id = ?`
          )
          .bind(workspaceId, tableId, field.id, row.record_id)
      );
      continue;
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO field_index_entries (
             workspace_id,
             table_id,
             field_id,
             record_id,
             index_value_text,
             index_value_number,
             index_value_datetime,
             index_value_bool,
             last_event_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, table_id, field_id, record_id) DO UPDATE SET
             index_value_text = excluded.index_value_text,
             index_value_number = excluded.index_value_number,
             index_value_datetime = excluded.index_value_datetime,
             index_value_bool = excluded.index_value_bool,
             last_event_id = excluded.last_event_id`
        )
        .bind(
          workspaceId,
          tableId,
          field.id,
          row.record_id,
          nextIndex.textValue ?? nextIndex.referenceValue ?? nextIndex.displayValue ?? null,
          toNumberValue(nextIndex),
          nextIndex.datetimeValue ?? null,
          nextIndex.boolValue == null ? null : nextIndex.boolValue ? 1 : 0,
          lastEventId
        )
    );
  }
}

async function resolvePatchFieldMap(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<Map<string, FieldRow>> {
  const fields = await listFields(db, workspaceId, tableId);
  const map = new Map<string, FieldRow>();
  for (const field of fields) {
    map.set(field.id, field);
    map.set(field.field_key, field);
  }

  return map;
}

async function appendDomainStatements(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  commit: EventLedgerCommit,
  statements: D1PreparedStatement[]
): Promise<void> {
  const { command, event } = commit;
  const payload = command.payload;

  switch (command.commandType) {
    case "base.create": {
      const baseId = payload.baseId as string;
      const slug = payload.slug as string;
      const name = payload.name as string;

      statements.push(
        db
          .prepare(
            `INSERT INTO apps (
              id,
              workspace_id,
              slug,
              name,
              created_at,
              updated_at,
              archived_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            baseId,
            command.workspaceId,
            slug,
            name,
            event.createdAt,
            event.createdAt,
            null,
            event.eventId
          )
      );
      return;
    }

    case "table.create": {
      const baseId = payload.baseId as string;
      const tableId = payload.tableId as string;
      const slug = payload.slug as string;
      const name = payload.name as string;
      const base = await getApp(db, command.workspaceId, baseId);
      if (!base) {
        throw new CommandCommitError(`base_not_found:${baseId}`);
      }

      statements.push(
        db
          .prepare(
            `INSERT INTO tables (
              id,
              workspace_id,
              app_id,
              slug,
              name,
              schema_epoch,
              current_schema_version,
              created_at,
              updated_at,
              archived_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            tableId,
            command.workspaceId,
            base.id,
            slug,
            name,
            0,
            1,
            event.createdAt,
            event.createdAt,
            null,
            event.eventId
          )
      );
      return;
    }

    case "field.create": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const fieldId = payload.fieldId as string;
      const fieldKey = payload.fieldKey as string;
      const label = payload.label as string;
      const fieldType = payload.fieldType as string;
      const config = asJsonValue(payload.config ?? {}) ?? {};

      statements.push(
        db
          .prepare(
            `INSERT INTO fields (
              id,
              workspace_id,
              table_id,
              field_key,
              label,
              field_type,
              field_type_version,
              config_json,
              created_at,
              updated_at,
              archived_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            fieldId,
            command.workspaceId,
            table.id,
            fieldKey,
            label,
            fieldType,
            fieldTypeRegistry.require(fieldType).version,
            JSON.stringify(config),
            event.createdAt,
            event.createdAt,
            null,
            event.eventId
          )
      );
      return;
    }

    case "field.update": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const fieldId = payload.fieldId as string;
      const field = await getField(db, command.workspaceId, table.id, fieldId);
      if (!field) {
        throw new CommandCommitError(`field_not_found:${fieldId}`);
      }

      if (!isSelectableOptionFieldType(field.field_type)) {
        throw new CommandCommitError(`field_update_unsupported:${field.field_type}`);
      }

      const definition = fieldTypeRegistry.require(field.field_type);
      const existingConfig = parseFieldConfig(field.config_json);
      const configPatch = asJsonValue(payload.config ?? null);
      if (!configPatch || typeof configPatch !== "object" || Array.isArray(configPatch)) {
        throw new CommandCommitError("payload_config_must_be_object");
      }

      const nextConfig = {
        ...(existingConfig as Record<string, JsonValue>),
        ...(configPatch as Record<string, JsonValue>)
      } satisfies Record<string, JsonValue>;
      const validation = definition.validateConfig(nextConfig, {
        fieldType: field.field_type
      });
      if (!validation.valid) {
        throw new CommandCommitError(
          validation.errors[0] ?? `invalid_field_config:${field.field_type}`
        );
      }

      statements.push(
        db
          .prepare(
            `UPDATE fields
             SET config_json = ?, updated_at = ?, last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(
            JSON.stringify(nextConfig),
            event.createdAt,
            event.eventId,
            command.workspaceId,
            table.id,
            field.id
          )
      );

      await appendSelectOptionSchemaBackfillStatements(
        db,
        fieldTypeRegistry,
        command.workspaceId,
        table.id,
        field,
        nextConfig,
        event.eventId,
        statements
      );
      return;
    }

    case "field.permission.configure": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const fieldId = payload.fieldId as string;
      const field = await getField(db, command.workspaceId, table.id, fieldId);
      if (!field) {
        throw new CommandCommitError(`field_not_found:${fieldId}`);
      }

      const principalId = payload.principalId as string;
      const policy = payload.policy as {
        agent: boolean;
        read: "visible" | "redacted" | "hidden";
        workflow: boolean;
        write: boolean;
      };
      const revision = await getNextPermissionRevision(db, command.workspaceId);
      const scopeHash = `scope:table:${table.id}`;
      const latestSnapshotRow = await getLatestPermissionSnapshot(
        db,
        command.workspaceId,
        principalId,
        scopeHash
      );
      const baseSnapshot = latestSnapshotRow
        ? (JSON.parse(latestSnapshotRow.snapshot_json) as {
            commandTypes?: string[];
            fields?: Record<string, unknown>;
          })
        : null;
      const fieldConfig = JSON.parse(field.config_json) as Record<string, unknown>;
      const permissionsByPrincipal =
        typeof fieldConfig.permissionsByPrincipal === "object" &&
        fieldConfig.permissionsByPrincipal !== null &&
        !Array.isArray(fieldConfig.permissionsByPrincipal)
          ? { ...(fieldConfig.permissionsByPrincipal as Record<string, unknown>) }
          : {};

      permissionsByPrincipal[principalId] = policy;

      const nextFieldConfig = {
        ...fieldConfig,
        permissionsByPrincipal
      };
      const snapshot = {
        snapshotId: `psnap_${event.eventId}`,
        workspaceId: command.workspaceId,
        principalId,
        policyRevision: revision,
        schemaEpoch: table.schema_epoch,
        scopeHash,
        commandTypes:
          Array.isArray(baseSnapshot?.commandTypes) && baseSnapshot.commandTypes.length > 0
            ? baseSnapshot.commandTypes
            : ["field.permission.configure", "record.create", "record.update", "record.archive", "cell.set"],
        fields: {
          ...((baseSnapshot?.fields as Record<string, unknown> | undefined) ?? {}),
          [field.id]: {
            agent: policy.agent,
            fieldId: field.id,
            fieldType: field.field_type,
            read: policy.read,
            workflow: policy.workflow,
            write: policy.write
          }
        }
      };
      const policyDocument = {
        fieldId: field.id,
        kind: "field_permission_configuration",
        policy,
        principalId,
        tableId: table.id
      };

      statements.push(
        db
          .prepare(
            `UPDATE fields
             SET config_json = ?, updated_at = ?, last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(
            JSON.stringify(nextFieldConfig),
            event.createdAt,
            event.eventId,
            command.workspaceId,
            table.id,
            field.id
          ),
        db
          .prepare(
            `INSERT INTO permission_policies (
              id,
              workspace_id,
              policy_key,
              revision,
              policy_json,
              created_at,
              created_by_principal_id,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `ppol_${event.eventId}`,
            command.workspaceId,
            `field:${table.id}:${field.id}`,
            revision,
            JSON.stringify(policyDocument),
            event.createdAt,
            command.actor.principalId,
            event.eventId
          ),
        db
          .prepare(
            `INSERT INTO permission_policy_bindings (
              id,
              workspace_id,
              binding_key,
              revision,
              binding_json,
              created_at,
              created_by_principal_id,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `pbind_${event.eventId}`,
            command.workspaceId,
            `field:${table.id}:${field.id}:principal:${principalId}`,
            revision,
            JSON.stringify({
              ...policyDocument,
              scopeHash
            }),
            event.createdAt,
            command.actor.principalId,
            event.eventId
          ),
        db
          .prepare(
            `INSERT INTO permission_snapshots (
              id,
              workspace_id,
              principal_id,
              policy_revision,
              scope_hash,
              snapshot_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            snapshot.snapshotId,
            command.workspaceId,
            principalId,
            revision,
            scopeHash,
            JSON.stringify(snapshot),
            event.createdAt
          )
      );
      return;
    }

    case "workflow.create": {
      const workflowId = payload.workflowId as string;
      const workflowKey = payload.workflowKey as string;
      const workflowName = payload.name as string;
      const tableId =
        typeof payload.tableId === "string" && payload.tableId.length > 0
          ? (payload.tableId as string)
          : command.tableId;
      if (!tableId) {
        throw new CommandCommitError("missing_tableId");
      }

      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const definition = normalizeWorkflowDefinition(command, {
        ...payload,
        tableId
      });
      const workflowVersionId = `${workflowId}:v1`;
      const refs = workflowDefinitionRefs(definition);

      statements.push(
        db
          .prepare(
            `INSERT INTO workflows (
              id,
              workspace_id,
              workflow_key,
              name,
              current_version,
              created_at,
              updated_at,
              archived_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            workflowId,
            command.workspaceId,
            workflowKey,
            workflowName,
            1,
            event.createdAt,
            event.createdAt,
            null,
            event.eventId
          ),
        db
          .prepare(
            `INSERT INTO workflow_versions (
              id,
              workspace_id,
              workflow_id,
              version,
              definition_json,
              published_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            workflowVersionId,
            command.workspaceId,
            workflowId,
            1,
            toCanonicalJson(definition).trimEnd(),
            null,
            event.eventId
          )
      );

      for (const [index, ref] of refs.entries()) {
        statements.push(
          db
            .prepare(
              `INSERT INTO workflow_operator_refs (
                id,
                workspace_id,
                workflow_version_id,
                operator_slot_key,
                operator_id,
                operator_version,
                config_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              `${workflowVersionId}:op:${index}`,
              command.workspaceId,
              workflowVersionId,
              ref.operatorSlotKey,
              ref.operatorId,
              ref.operatorVersion,
              ref.configJson
            )
        );
      }
      return;
    }

    case "workflow.publish":
    case "workflow.pause": {
      const workflowId = payload.workflowId as string;
      const workflow = await getWorkflow(db, command.workspaceId, workflowId);
      if (!workflow) {
        throw new CommandCommitError(`workflow_not_found:${workflowId}`);
      }

      const version = await getCurrentWorkflowVersion(
        db,
        command.workspaceId,
        workflow.id,
        workflow.current_version
      );
      if (!version) {
        throw new CommandCommitError(`workflow_version_not_found:${workflowId}:v${workflow.current_version}`);
      }

      const parsedDefinition = asWorkflowDefinition(JSON.parse(version.definition_json));
      if (!parsedDefinition) {
        throw new CommandCommitError("workflow_definition_invalid");
      }

      if (command.commandType === "workflow.publish") {
        assertPublishableWorkflowDefinition(parsedDefinition);
      } else if (version.published_at == null) {
        throw new CommandCommitError(`workflow_not_published:${workflowId}`);
      }

      const nextStatus = command.commandType === "workflow.publish" ? "published" : "paused";
      const nextDefinition = updateWorkflowStatus(parsedDefinition, nextStatus);

      statements.push(
        db
          .prepare(
            `UPDATE workflows
             SET updated_at = ?, last_event_id = ?
             WHERE workspace_id = ? AND id = ?`
          )
          .bind(event.createdAt, event.eventId, command.workspaceId, workflow.id),
        db
          .prepare(
            `UPDATE workflow_versions
             SET definition_json = ?,
                 published_at = ?,
                 last_event_id = ?
             WHERE workspace_id = ? AND id = ?`
          )
          .bind(
            toCanonicalJson(nextDefinition).trimEnd(),
            command.commandType === "workflow.publish"
              ? event.createdAt
              : version.published_at,
            event.eventId,
            command.workspaceId,
            version.id
          )
      );
      return;
    }

    case "record.create": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const recordId = payload.recordId as string;
      const recordKey =
        typeof payload.recordKey === "string" && payload.recordKey.length > 0
          ? (payload.recordKey as string)
          : stableRecordKeyFromId(recordId);
      const cells = (payload.cells as Record<string, unknown> | undefined) ?? {};

      statements.push(
        db
          .prepare(
            `INSERT INTO records (
              id,
              workspace_id,
              table_id,
              record_key,
              record_revision,
              created_at,
              updated_at,
              archived_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            recordId,
            command.workspaceId,
            table.id,
            recordKey,
            0,
            event.createdAt,
            event.createdAt,
            null,
            event.eventId
          )
      );

      const projectionCells: CellStateRow[] = [];
      const sortedFieldIds = Object.keys(cells).sort();
      for (const fieldId of sortedFieldIds) {
        const mutation = await buildCellMutation(
          db,
          fieldTypeRegistry,
          command.workspaceId,
          table.id,
          fieldId,
          cells[fieldId]
        );

        projectionCells.push({
          cell_revision: 1,
          display_value: mutation.index.displayValue,
          field_id: fieldId,
          field_key: mutation.field.field_key,
          value_json: JSON.stringify(mutation.normalized)
        });

        statements.push(
          db
            .prepare(
              `INSERT INTO cell_current (
                record_id,
                field_id,
                workspace_id,
                table_id,
                value_type,
                value_version,
                value_json,
                text_value,
                number_value,
                bool_value,
                datetime_value,
                reference_value,
                display_value,
                search_text,
                value_hash,
                cell_revision,
                last_event_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              recordId,
              fieldId,
              command.workspaceId,
              table.id,
              mutation.normalized?.valueType ?? mutation.field.field_type,
              mutation.normalized?.version ?? mutation.field.field_type_version,
              JSON.stringify(mutation.normalized),
              mutation.index.textValue ?? null,
              toNumberValue(mutation.index),
              mutation.index.boolValue === undefined || mutation.index.boolValue === null
                ? null
                : mutation.index.boolValue
                  ? 1
                  : 0,
              mutation.index.datetimeValue ?? null,
              mutation.index.referenceValue ?? null,
              mutation.index.displayValue,
              mutation.index.searchText,
              mutation.index.valueHash,
              1,
              event.eventId
            )
        );
      }

      statements.push(
        db
          .prepare(
            `INSERT INTO record_projection (
              workspace_id,
              table_id,
              record_id,
              projection_json,
              search_document,
              projection_version,
              last_event_id,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            command.workspaceId,
            table.id,
            recordId,
            buildRecordProjection(projectionCells),
            "",
            1,
            event.eventId,
            event.createdAt
          )
      );
      return;
    }

    case "record.update": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const recordId = payload.recordId as string;
      const record = await getRecord(db, command.workspaceId, table.id, recordId);
      if (!record) {
        throw new CommandCommitError(`record_not_found:${recordId}`);
      }

      const patch =
        typeof payload.patch === "object" && payload.patch !== null && !Array.isArray(payload.patch)
          ? (payload.patch as Record<string, unknown>)
          : null;
      if (!patch) {
        throw new CommandCommitError("payload_patch_must_be_object");
      }

      const fieldsByIdentifier = await resolvePatchFieldMap(
        db,
        command.workspaceId,
        table.id
      );
      const existingCells = await getRecordCells(
        db,
        command.workspaceId,
        table.id,
        recordId
      );
      const existingCellsByFieldId = new Map(
        existingCells.map((cell) => [cell.field_id, cell] as const)
      );
      const mergedCellsByFieldId = new Map(
        existingCells.map((cell) => [cell.field_id, cell] as const)
      );

      for (const patchKey of Object.keys(patch).sort()) {
        const field = fieldsByIdentifier.get(patchKey);
        if (!field) {
          throw new CommandCommitError(`field_not_found:${patchKey}`);
        }

        const fieldType = fieldTypeRegistry.require(field.field_type);
        const fieldConfig = parseFieldConfig(field.config_json);
        const normalized = fieldType.normalize(patch[patchKey], {
          fieldConfig,
          fieldType: field.field_type
        }).value;
        const validation = fieldType.validateValue(normalized, {
          fieldConfig,
          fieldType: field.field_type
        });
        if (!validation.valid) {
          throw new CommandCommitError(
            validation.errors[0] ?? `invalid_field_value:${field.field_type}`
          );
        }
        const index = fieldType.toIndex(normalized, {
          fieldConfig,
          fieldType: field.field_type
        });
        const existingCell = existingCellsByFieldId.get(field.id) ?? null;
        const nextCellRevision = (existingCell?.cell_revision ?? 0) + 1;

        mergedCellsByFieldId.set(field.id, {
          cell_revision: nextCellRevision,
          display_value: index.displayValue,
          field_id: field.id,
          field_key: field.field_key,
          value_json: JSON.stringify(normalized)
        });

        statements.push(
          db
            .prepare(
              `INSERT INTO cell_current (
                record_id,
                field_id,
                workspace_id,
                table_id,
                value_type,
                value_version,
                value_json,
                text_value,
                number_value,
                bool_value,
                datetime_value,
                reference_value,
                display_value,
                search_text,
                value_hash,
                cell_revision,
                last_event_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(record_id, field_id) DO UPDATE SET
                value_type = excluded.value_type,
                value_version = excluded.value_version,
                value_json = excluded.value_json,
                text_value = excluded.text_value,
                number_value = excluded.number_value,
                bool_value = excluded.bool_value,
                datetime_value = excluded.datetime_value,
                reference_value = excluded.reference_value,
                display_value = excluded.display_value,
                search_text = excluded.search_text,
                value_hash = excluded.value_hash,
                cell_revision = excluded.cell_revision,
                last_event_id = excluded.last_event_id`
            )
            .bind(
              recordId,
              field.id,
              command.workspaceId,
              table.id,
              normalized?.valueType ?? field.field_type,
              normalized?.version ?? field.field_type_version,
              JSON.stringify(normalized),
              index.textValue ?? null,
              toNumberValue(index),
              index.boolValue === undefined || index.boolValue === null
                ? null
                : index.boolValue
                  ? 1
                  : 0,
              index.datetimeValue ?? null,
              index.referenceValue ?? null,
              index.displayValue,
              index.searchText,
              index.valueHash,
              nextCellRevision,
              event.eventId
            )
        );
      }

      const mergedCells = [...mergedCellsByFieldId.values()].sort((left, right) =>
        left.field_key.localeCompare(right.field_key)
      );
      const nextRecordRevision = record.record_revision + 1;

      statements.push(
        db
          .prepare(
            `UPDATE records
             SET record_revision = ?,
                 updated_at = ?,
                 last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(
            nextRecordRevision,
            event.createdAt,
            event.eventId,
            command.workspaceId,
            table.id,
            recordId
          ),
        db
          .prepare(
            `INSERT INTO record_projection (
              workspace_id,
              table_id,
              record_id,
              projection_json,
              search_document,
              projection_version,
              last_event_id,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, table_id, record_id) DO UPDATE SET
              projection_json = excluded.projection_json,
              projection_version = record_projection.projection_version + 1,
              last_event_id = excluded.last_event_id,
              updated_at = excluded.updated_at`
          )
          .bind(
            command.workspaceId,
            table.id,
            recordId,
            buildRecordProjection(mergedCells),
            "",
            1,
            event.eventId,
            event.createdAt
          )
      );
      return;
    }

    case "record.archive": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const recordId = payload.recordId as string;
      const record = await getRecord(db, command.workspaceId, table.id, recordId);
      if (!record) {
        throw new CommandCommitError(`record_not_found:${recordId}`);
      }

      const nextRecordRevision = record.record_revision + 1;
      statements.push(
        db
          .prepare(
            `UPDATE records
             SET record_revision = ?,
                 updated_at = ?,
                 archived_at = ?,
                 last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(
            nextRecordRevision,
            event.createdAt,
            event.createdAt,
            event.eventId,
            command.workspaceId,
            table.id,
            recordId
          ),
        db
          .prepare(
            `DELETE FROM cell_current
             WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
          )
          .bind(command.workspaceId, table.id, recordId),
        db
          .prepare(
            `DELETE FROM record_projection
             WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
          )
          .bind(command.workspaceId, table.id, recordId)
      );
      return;
    }

    case "view.create":
    case "view.update": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const viewId = payload.viewId as string;
      const viewName = payload.viewName as string;
      const schemaInput = readViewSchemaPayload(payload);
      const viewKey =
        command.commandType === "view.create"
          ? typeof payload.viewKey === "string" && payload.viewKey.length > 0
            ? (payload.viewKey as string)
            : viewId.replace(/^view_/, "view-")
          : null;
      const existingView =
        command.commandType === "view.update"
          ? await getView(db, command.workspaceId, table.id, viewId)
          : null;

      if (command.commandType === "view.update" && !existingView) {
        throw new CommandCommitError(`view_not_found:${viewId}`);
      }

      const fieldRows = await db
        .prepare(
          `SELECT id
           FROM fields
           WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
        )
        .bind(command.workspaceId, table.id)
        .all<{ id: string }>();
      const knownFields = new Set((fieldRows.results ?? []).map((field) => field.id));

      for (const fieldId of [
        ...schemaInput.visibleFieldIds,
        ...schemaInput.filterFieldIds,
        ...schemaInput.sortFieldIds,
        ...(schemaInput.groupByFieldId ? [schemaInput.groupByFieldId] : [])
      ]) {
        if (!knownFields.has(fieldId)) {
          throw new CommandCommitError(`field_not_found:${fieldId}`);
        }
      }

      const schema = toCanonicalJson(schemaInput).trimEnd();

      if (command.commandType === "view.create") {
        statements.push(
          db
            .prepare(
              `INSERT INTO views (
                id,
                workspace_id,
                table_id,
                view_key,
                name,
                current_schema_version,
                created_at,
                updated_at,
                archived_at,
                last_event_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              viewId,
              command.workspaceId,
              table.id,
              viewKey,
              viewName,
              1,
              event.createdAt,
              event.createdAt,
              null,
              event.eventId
            ),
          db
            .prepare(
              `INSERT INTO view_schema_versions (
                id,
                workspace_id,
                view_id,
                schema_version,
                schema_json,
                created_at,
                created_by_principal_id,
                last_event_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              `${viewId}:v1`,
              command.workspaceId,
              viewId,
              1,
              schema,
              event.createdAt,
              command.actor.principalId,
              event.eventId
            )
        );
      } else {
        const nextSchemaVersion = existingView!.current_schema_version + 1;
        statements.push(
          db
            .prepare(
              `UPDATE views
               SET name = ?,
                   current_schema_version = ?,
                   updated_at = ?,
                   last_event_id = ?
               WHERE workspace_id = ? AND table_id = ? AND id = ?`
            )
            .bind(
              viewName,
              nextSchemaVersion,
              event.createdAt,
              event.eventId,
              command.workspaceId,
              table.id,
              viewId
            ),
          db
            .prepare(
              `INSERT INTO view_schema_versions (
                id,
                workspace_id,
                view_id,
                schema_version,
                schema_json,
                created_at,
                created_by_principal_id,
                last_event_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              `${viewId}:v${nextSchemaVersion}`,
              command.workspaceId,
              viewId,
              nextSchemaVersion,
              schema,
              event.createdAt,
              command.actor.principalId,
              event.eventId
            )
        );
      }
      return;
    }

    case "cell.set": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const recordId = payload.recordId as string;
      const record = await getRecord(db, command.workspaceId, table.id, recordId);
      if (!record) {
        throw new CommandCommitError(`record_not_found:${recordId}`);
      }

      const fieldId = payload.fieldId as string;
      const mutation = await buildCellMutation(
        db,
        fieldTypeRegistry,
        command.workspaceId,
        table.id,
        fieldId,
        payload.value
      );

      const existingCells = await getRecordCells(
        db,
        command.workspaceId,
        table.id,
        recordId
      );
      const existingCell = existingCells.find((cell) => cell.field_id === fieldId) ?? null;
      const nextCellRevision = (existingCell?.cell_revision ?? 0) + 1;
      const nextRecordRevision = record.record_revision + 1;
      const mergedCells = [
        ...existingCells.filter((cell) => cell.field_id !== fieldId),
        {
          cell_revision: nextCellRevision,
          display_value: mutation.index.displayValue,
          field_id: fieldId,
          field_key: mutation.field.field_key,
          value_json: JSON.stringify(mutation.normalized)
        }
      ].sort((left, right) => left.field_key.localeCompare(right.field_key));

      statements.push(
        db
          .prepare(
            `UPDATE records
             SET record_revision = ?,
                 updated_at = ?,
                 last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(
            nextRecordRevision,
            event.createdAt,
            event.eventId,
            command.workspaceId,
            table.id,
            recordId
          ),
        db
          .prepare(
            `INSERT INTO cell_current (
              record_id,
              field_id,
              workspace_id,
              table_id,
              value_type,
              value_version,
              value_json,
              text_value,
              number_value,
              bool_value,
              datetime_value,
              reference_value,
              display_value,
              search_text,
              value_hash,
              cell_revision,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(record_id, field_id) DO UPDATE SET
              value_type = excluded.value_type,
              value_version = excluded.value_version,
              value_json = excluded.value_json,
              text_value = excluded.text_value,
              number_value = excluded.number_value,
              bool_value = excluded.bool_value,
              datetime_value = excluded.datetime_value,
              reference_value = excluded.reference_value,
              display_value = excluded.display_value,
              search_text = excluded.search_text,
              value_hash = excluded.value_hash,
              cell_revision = excluded.cell_revision,
              last_event_id = excluded.last_event_id`
          )
          .bind(
            recordId,
            fieldId,
            command.workspaceId,
            table.id,
            mutation.normalized?.valueType ?? mutation.field.field_type,
            mutation.normalized?.version ?? mutation.field.field_type_version,
            JSON.stringify(mutation.normalized),
            mutation.index.textValue ?? null,
            toNumberValue(mutation.index),
            mutation.index.boolValue === undefined || mutation.index.boolValue === null
              ? null
              : mutation.index.boolValue
                ? 1
                : 0,
            mutation.index.datetimeValue ?? null,
            mutation.index.referenceValue ?? null,
            mutation.index.displayValue,
            mutation.index.searchText,
            mutation.index.valueHash,
            nextCellRevision,
            event.eventId
          ),
        db
          .prepare(
            `INSERT INTO record_projection (
              workspace_id,
              table_id,
              record_id,
              projection_json,
              search_document,
              projection_version,
              last_event_id,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, table_id, record_id) DO UPDATE SET
              projection_json = excluded.projection_json,
              projection_version = record_projection.projection_version + 1,
              last_event_id = excluded.last_event_id,
              updated_at = excluded.updated_at`
          )
          .bind(
            command.workspaceId,
            table.id,
            recordId,
            buildRecordProjection(mergedCells),
            "",
            1,
            event.eventId,
            event.createdAt
          )
      );
      return;
    }
  }
}

async function nextWorkspaceSequence(
  db: D1Database,
  workspaceId: string
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COALESCE(MAX(workspace_sequence), 0) + 1 AS nextSequence
       FROM event_ledger
       WHERE workspace_id = ?`
    )
    .bind(workspaceId)
    .first<SequenceRow>();

  return result?.nextSequence ?? 1;
}

async function nextTableSequence(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COALESCE(MAX(table_sequence), 0) + 1 AS nextSequence
       FROM event_ledger
       WHERE workspace_id = ? AND table_id = ?`
    )
    .bind(workspaceId, tableId)
    .first<SequenceRow>();

  return result?.nextSequence ?? 1;
}

export function createCloudTableD1Repository(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry = createFieldTypeRegistry()
): CloudTableRepository {
  return {
    async findReceipt(scopeKey, idempotencyKey) {
      const row = await db
        .prepare(
          `SELECT receipt_json
           FROM idempotency_receipts
           WHERE scope_key = ? AND idempotency_key = ?`
        )
        .bind(scopeKey, idempotencyKey)
        .first<ReceiptRow>();

      return row ? parseReceipt(row) : null;
    },

    async listOutboxEntriesForEvent(eventId) {
      const rows = await db
        .prepare(
          `SELECT
             outbox_id,
             workspace_id,
             event_id,
             queue_name,
             payload_json,
             available_at,
             delivered_at,
             delivery_attempts,
             created_at
           FROM queue_outbox
           WHERE event_id = ?
           ORDER BY created_at ASC, outbox_id ASC`
        )
        .bind(eventId)
        .all<OutboxRow>();

      return rows.results ?? [];
    },

    async commitAcceptedCommand(commit) {
      const workspaceSequence = await nextWorkspaceSequence(db, commit.command.workspaceId);
      const tableSequence = commit.command.tableId
        ? await nextTableSequence(db, commit.command.workspaceId, commit.command.tableId)
        : null;
      const projection = projectionPayloadFromCommit(commit);

      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `INSERT INTO event_ledger (
              event_id,
              workspace_id,
              table_id,
              event_type,
              command_id,
              aggregate_id,
              workspace_sequence,
              table_sequence,
              payload_json,
              metadata_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            commit.event.eventId,
            commit.event.workspaceId,
            commit.event.tableId,
            commit.event.eventType,
            commit.event.commandId,
            commit.event.aggregateId ?? null,
            workspaceSequence,
            tableSequence,
            JSON.stringify(commit.event.payload),
            JSON.stringify({
              ...commit.event.metadata,
              commandType: commit.event.commandType
            }),
            commit.event.createdAt
          ),
        db
          .prepare(
            `INSERT INTO idempotency_receipts (
              id,
              scope_key,
              idempotency_key,
              command_id,
              receipt_json,
              created_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `receipt:${commit.event.eventId}`,
            commit.scopeKey,
            commit.receipt.idempotencyKey,
            commit.command.commandId,
            JSON.stringify(commit.receipt),
            commit.event.createdAt,
            commit.event.eventId
          ),
        db
          .prepare(
            `INSERT INTO queue_outbox (
              outbox_id,
              workspace_id,
              event_id,
              queue_name,
              payload_json,
              available_at,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `outbox:${commit.event.eventId}:event-fanout`,
            commit.command.workspaceId,
            commit.event.eventId,
            "event-fanout",
            JSON.stringify({
              commandId: commit.command.commandId,
              eventId: commit.event.eventId,
              eventType: commit.event.eventType,
              workspaceId: commit.command.workspaceId
            }),
            commit.event.createdAt,
            commit.event.createdAt
          )
      ];

      if (projection) {
        statements.push(
          db
            .prepare(
              `INSERT INTO record_projection (
                workspace_id,
                table_id,
                record_id,
                projection_json,
                search_document,
                projection_version,
                last_event_id,
                updated_at
              ) VALUES (?, ?, ?, ?, '', 1, ?, ?)
              ON CONFLICT(workspace_id, table_id, record_id) DO UPDATE SET
                projection_json = excluded.projection_json,
                projection_version = record_projection.projection_version + 1,
                last_event_id = excluded.last_event_id,
                updated_at = excluded.updated_at`
            )
            .bind(
              commit.command.workspaceId,
              commit.command.tableId,
              projection.record_id,
              projection.projection_json,
              commit.event.eventId,
              commit.event.createdAt
            )
        );
      }

      await appendDomainStatements(db, fieldTypeRegistry, commit, statements);

      await db.batch(statements);

      const receiptRows = await db
        .prepare(
          `SELECT receipt_json
           FROM idempotency_receipts
           WHERE scope_key = ?
           ORDER BY created_at ASC, id ASC`
        )
        .bind(commit.scopeKey)
        .all<ReceiptRow>();

      return {
        event: {
          ...commit.event,
          metadata: {
            ...commit.event.metadata,
            tableSequence,
            workspaceSequence
          }
        } satisfies EventLedgerRecord,
        receipts: (receiptRows.results ?? []).map(parseReceipt)
      };
    }
  };
}
