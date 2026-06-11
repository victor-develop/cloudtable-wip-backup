import { createFieldTypeRegistry } from "../field-types/registry";
import type {
  FieldIndexValue,
  FieldTypeRegistry,
  JsonValue,
  NormalizedCellValue
} from "../field-types/types";
import {
  findRowOwnerField,
  isRowOwnerEnabled
} from "../ownership/row-owner";
import { CommandCommitError } from "../commands/errors";
import { isSupportedDomainCommandType } from "../commands/domain";
import { toCanonicalJson } from "../commands/transcript";
import type { IdempotencyReceipt } from "../commands/types";
import type { EventLedgerCommit, EventLedgerRecord } from "../events/types";
import { createWorkflowOperatorRegistry } from "../workflows/operator-registry";
import { validateWorkflowConditionBindings } from "../workflows/authoring";
import { buildWorkflowAuthoringMetadataForFields as buildSharedWorkflowAuthoringMetadataForFields } from "../workflows/binding-metadata";
import type {
  WorkflowActionBinding,
  WorkflowAuthoringMetadata,
  WorkflowConditionBinding,
  WorkflowDefinition,
  WorkflowTriggerBinding
} from "../workflows/types";
import type {
  ActivityHistoryEntry,
  CloudTableRepository,
  OutboxRow,
  ReceiptRow
} from "./types";

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
  created_at?: string;
  field_key: string;
  field_order?: number | null;
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
  table_id?: string;
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
  field_order?: number | null;
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
  name?: string;
  workflow_key?: string;
};

type WorkflowVersionRow = {
  definition_json: string;
  id: string;
  published_at: string | null;
  version: number;
  workflow_id: string;
};

type ActivityHistoryRow = {
  actor_mode: string | null;
  actor_principal_id: string | null;
  aggregate_id: string | null;
  aggregate_type: string | null;
  command_id: string;
  command_type: string | null;
  created_at: string;
  event_id: string;
  event_type: string;
  record_id: string | null;
  record_key: string | null;
  table_id: string | null;
  table_sequence: number | null;
  workspace_sequence: number;
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

function activityRecordIdSql(eventAlias = "event_ledger"): string {
  return `CASE
    WHEN json_extract(${eventAlias}.payload_json, '$.recordId') IS NOT NULL
      THEN json_extract(${eventAlias}.payload_json, '$.recordId')
    WHEN json_extract(${eventAlias}.metadata_json, '$.aggregateType') = 'record'
      THEN ${eventAlias}.aggregate_id
    ELSE NULL
  END`;
}

function mapActivityHistoryRow(row: ActivityHistoryRow): ActivityHistoryEntry {
  return {
    actorMode: row.actor_mode,
    actorPrincipalId: row.actor_principal_id,
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    commandId: row.command_id,
    commandType: row.command_type,
    createdAt: row.created_at,
    eventId: row.event_id,
    eventType: row.event_type,
    recordId: row.record_id,
    recordKey: row.record_key,
    tableId: row.table_id,
    tableSequence: row.table_sequence,
    workspaceSequence: row.workspace_sequence
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asWorkflowDefinition(
  value: unknown
): (WorkflowDefinition & { metadata?: Record<string, unknown> }) | null {
  return isRecord(value) ? (value as WorkflowDefinition & { metadata?: Record<string, unknown> }) : null;
}

function normalizeWorkflowTriggerMatcher(match: unknown): WorkflowTriggerBinding["match"] {
  if (!isRecord(match)) {
    return undefined;
  }

  const normalizedMatch: Record<string, unknown> = { ...match };
  const fieldIds = Array.isArray(match.fieldIds)
    ? match.fieldIds.filter(
        (fieldId): fieldId is string => typeof fieldId === "string" && fieldId.length > 0
      )
    : typeof match.fieldId === "string" && match.fieldId.length > 0
      ? [match.fieldId]
      : [];

  delete normalizedMatch.fieldId;
  delete normalizedMatch.fieldIds;

  if (fieldIds.length > 0) {
    normalizedMatch.fieldIds = Array.from(new Set(fieldIds));
  }

  return Object.keys(normalizedMatch).length > 0
    ? (normalizedMatch as WorkflowTriggerBinding["match"])
    : undefined;
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
      ? ({
          ...(definition.trigger as WorkflowTriggerBinding),
          match: normalizeWorkflowTriggerMatcher((definition.trigger as WorkflowTriggerBinding).match)
        } satisfies WorkflowTriggerBinding)
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

function buildWorkflowAuthoringMetadataForFields(
  fieldTypeRegistry: FieldTypeRegistry,
  fields: readonly FieldRow[]
): WorkflowAuthoringMetadata {
  return buildSharedWorkflowAuthoringMetadataForFields(fieldTypeRegistry, fields, (field) => ({
    config: JSON.parse(field.config_json) as JsonValue,
    fieldId: field.id,
    fieldKey: field.field_key,
    fieldType: field.field_type
  }));
}

function assertWorkflowConditionBindings(
  definition: WorkflowDefinition,
  authoringMetadata: WorkflowAuthoringMetadata
): void {
  const diagnostics = validateWorkflowConditionBindings(definition, authoringMetadata);
  if (diagnostics.length > 0) {
    throw new CommandCommitError(diagnostics[0] ?? "workflow_condition_binding_invalid");
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

function resolveRowOwnerField(fields: readonly FieldRow[]): FieldRow | null {
  const rowOwnerCandidate = findRowOwnerField(
    fields.map((field) => ({
      config: parseFieldConfig(field.config_json),
      fieldId: field.id,
      fieldKey: field.field_key,
      fieldType: field.field_type
    }))
  );
  if (!rowOwnerCandidate) {
    return null;
  }

  return fields.find((field) => field.id === rowOwnerCandidate.fieldId) ?? null;
}

function parseNormalizedCellValue(raw: string): NormalizedCellValue | null {
  return JSON.parse(raw) as NormalizedCellValue | null;
}

function assertRowOwnerCellValue(
  rowOwnerField: FieldRow | null,
  cell: Pick<CellStateRow, "value_json"> | null | undefined
): void {
  if (!rowOwnerField) {
    return;
  }

  const normalized = cell ? parseNormalizedCellValue(cell.value_json) : null;
  if (normalized == null || normalized.isEmpty) {
    throw new CommandCommitError(`row_owner_value_required:${rowOwnerField.id}`);
  }
}

function assertRowOwnerFieldConfiguration(
  fields: readonly FieldRow[],
  input: {
    candidateFieldId: string;
    config: JsonValue;
    fieldType: string;
  }
): void {
  if (!isRowOwnerEnabled(input.config)) {
    return;
  }

  if (input.fieldType !== "principal.user") {
    throw new CommandCommitError("row_owner_field_must_use_principal_user");
  }

  const conflictingField = fields.find(
    (field) =>
      field.id !== input.candidateFieldId && isRowOwnerEnabled(parseFieldConfig(field.config_json))
  );
  if (conflictingField) {
    throw new CommandCommitError(`row_owner_field_conflict:${conflictingField.id}`);
  }
}

async function tableHasActiveRecords(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS has_records
       FROM records
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL
       LIMIT 1`
    )
    .bind(workspaceId, tableId)
    .first<{ has_records: number }>();

  return row?.has_records === 1;
}

async function tableHasRecordsMissingRowOwnerValue(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  fieldId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS has_missing
       FROM records
       LEFT JOIN cell_current
         ON cell_current.workspace_id = records.workspace_id
        AND cell_current.table_id = records.table_id
        AND cell_current.record_id = records.id
        AND cell_current.field_id = ?
       WHERE records.workspace_id = ?
         AND records.table_id = ?
         AND records.archived_at IS NULL
         AND (
           cell_current.record_id IS NULL OR
           COALESCE(json_extract(cell_current.value_json, '$.isEmpty'), 1) = 1
         )
       LIMIT 1`
    )
    .bind(fieldId, workspaceId, tableId)
    .first<{ has_missing: number }>();

  return row?.has_missing === 1;
}

async function assertRowOwnerActivationInvariant(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  input: {
    activatingExistingField: boolean;
    fieldId: string;
    nextConfig: JsonValue;
  }
): Promise<void> {
  if (!isRowOwnerEnabled(input.nextConfig)) {
    return;
  }

  const hasMissingValues = input.activatingExistingField
    ? await tableHasRecordsMissingRowOwnerValue(db, workspaceId, tableId, input.fieldId)
    : await tableHasActiveRecords(db, workspaceId, tableId);
  if (hasMissingValues) {
    throw new CommandCommitError(`row_owner_backfill_required:${input.fieldId}`);
  }
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
      `SELECT id, current_version, workflow_key, name
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
         field_order,
         config_json,
         label,
         created_at
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, fieldId)
    .first<FieldRow>();
}

async function findFieldAcrossWorkspace(
  db: D1Database,
  workspaceId: string,
  fieldId: string
): Promise<(FieldRow & { archived_at: string | null; table_id: string }) | null> {
  return db
    .prepare(
      `SELECT
         id,
         table_id,
         field_key,
         field_type,
         field_type_version,
         field_order,
         config_json,
         label,
         created_at,
         archived_at
       FROM fields
       WHERE workspace_id = ? AND id = ?`
    )
    .bind(workspaceId, fieldId)
    .first<FieldRow & { archived_at: string | null; table_id: string }>();
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
         field_order,
         config_json,
         label,
         created_at
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId)
    .all<FieldRow>();

  return rows.results ?? [];
}

function compareFieldRows(left: FieldRow, right: FieldRow): number {
  const leftOrder = typeof left.field_order === "number" ? left.field_order : null;
  const rightOrder = typeof right.field_order === "number" ? right.field_order : null;

  if (leftOrder === null && rightOrder === null) {
    return (left.created_at ?? "").localeCompare(right.created_at ?? "") || left.id.localeCompare(right.id);
  }
  if (leftOrder === null) {
    return -1;
  }
  if (rightOrder === null) {
    return 1;
  }
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return (left.created_at ?? "").localeCompare(right.created_at ?? "") || left.id.localeCompare(right.id);
}

async function appendDenseFieldOrderStatements(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  event: EventLedgerRecord,
  fields: FieldRow[],
  statements: D1PreparedStatement[]
): Promise<FieldRow[]> {
  const orderedFields = [...fields].sort(compareFieldRows);
  let nextOrder = 1;
  let mutated = false;

  for (const field of orderedFields) {
    if (field.field_order !== nextOrder) {
      statements.push(
        db
          .prepare(
            `UPDATE fields
             SET field_order = ?, updated_at = ?, last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(nextOrder, event.createdAt, event.eventId, workspaceId, tableId, field.id)
      );
      mutated = true;
    }
    field.field_order = nextOrder;
    nextOrder += 1;
  }

  return mutated ? orderedFields : orderedFields;
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

async function getRecordById(
  db: D1Database,
  workspaceId: string,
  recordId: string
): Promise<RecordStateRow | null> {
  return db
    .prepare(
      `SELECT record_key, record_revision, last_event_id, table_id
       FROM records
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, recordId)
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
         fields.field_order,
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
       ORDER BY
         CASE WHEN fields.field_order IS NULL THEN 0 ELSE 1 END ASC,
         CASE WHEN fields.field_order IS NULL THEN fields.created_at ELSE NULL END ASC,
         CASE WHEN fields.field_order IS NULL THEN fields.id ELSE NULL END ASC,
         fields.field_order ASC,
         fields.id ASC`
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
  const showEmptyGroups = payload.showEmptyGroups === true;

  return {
    filterFieldIds,
    filters: effectiveFilters,
    groupByFieldId,
    showEmptyGroups,
    sortFieldIds,
    sorts: effectiveSorts,
    visibleFieldIds
  };
}

function validateViewSchemaFieldCapabilities(
  fieldTypeRegistry: FieldTypeRegistry,
  fieldRows: readonly Pick<FieldRow, "field_type" | "id">[],
  schemaInput: ReturnType<typeof readViewSchemaPayload>
): void {
  const fieldsById = new Map(fieldRows.map((field) => [field.id, field]));

  for (const fieldId of [
    ...schemaInput.visibleFieldIds,
    ...schemaInput.filterFieldIds,
    ...schemaInput.sortFieldIds,
    ...(schemaInput.groupByFieldId ? [schemaInput.groupByFieldId] : [])
  ]) {
    if (!fieldsById.has(fieldId)) {
      throw new CommandCommitError(`field_not_found:${fieldId}`);
    }
  }

  for (const fieldId of schemaInput.filterFieldIds) {
    const field = fieldsById.get(fieldId)!;
    const definition = fieldTypeRegistry.require(field.field_type);
    if (!definition.capabilities.supportsFiltering) {
      throw new CommandCommitError(`view_filter_unsupported:${fieldId}`);
    }
  }

  for (const fieldId of schemaInput.sortFieldIds) {
    const field = fieldsById.get(fieldId)!;
    const definition = fieldTypeRegistry.require(field.field_type);
    if (!definition.capabilities.supportsSorting) {
      throw new CommandCommitError(`view_sort_unsupported:${fieldId}`);
    }
  }

  if (schemaInput.groupByFieldId) {
    const field = fieldsById.get(schemaInput.groupByFieldId)!;
    const definition = fieldTypeRegistry.require(field.field_type);
    if (!definition.capabilities.supportsGrouping) {
      throw new CommandCommitError(`view_group_unsupported:${schemaInput.groupByFieldId}`);
    }
  }
}

function buildRecordProjection(cells: CellStateRow[]): string {
  const fields = Object.fromEntries(
    cells.map((cell) => {
      const parsed = JSON.parse(cell.value_json) as NormalizedCellValue | null;
      return [cell.field_key, parsed?.raw ?? null];
    })
  );

  return JSON.stringify({ fields }, null, 2);
}

function compareCellStateRows(left: CellStateRow, right: CellStateRow): number {
  const leftOrder = typeof left.field_order === "number" ? left.field_order : null;
  const rightOrder = typeof right.field_order === "number" ? right.field_order : null;

  if (leftOrder === null && rightOrder === null) {
    return left.field_key.localeCompare(right.field_key) || left.field_id.localeCompare(right.field_id);
  }
  if (leftOrder === null) {
    return -1;
  }
  if (rightOrder === null) {
    return 1;
  }
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.field_key.localeCompare(right.field_key) || left.field_id.localeCompare(right.field_id);
}

async function appendFieldArchiveProjectionStatements(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  fieldKey: string,
  event: EventLedgerRecord,
  statements: D1PreparedStatement[]
): Promise<void> {
  const projections = await db
    .prepare(
      `SELECT record_id, projection_json
       FROM record_projection
       WHERE workspace_id = ? AND table_id = ?`
    )
    .bind(workspaceId, tableId)
    .all<{ projection_json: string; record_id: string }>();

  for (const projection of projections.results ?? []) {
    const parsed = JSON.parse(projection.projection_json) as {
      fields?: Record<string, unknown>;
    };
    if (
      !parsed.fields ||
      typeof parsed.fields !== "object" ||
      !Object.prototype.hasOwnProperty.call(parsed.fields, fieldKey)
    ) {
      continue;
    }

    const nextFields = { ...parsed.fields };
    delete nextFields[fieldKey];

    statements.push(
      db
        .prepare(
          `UPDATE record_projection
           SET projection_json = ?,
               projection_version = projection_version + 1,
               last_event_id = ?,
               updated_at = ?
           WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
        )
        .bind(
          JSON.stringify({ fields: nextFields }, null, 2),
          event.eventId,
          event.createdAt,
          workspaceId,
          tableId,
          projection.record_id
        )
    );
  }
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
  await validateCommittedCellValue(db, workspaceId, field, fieldConfig, normalized);
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

async function validateCommittedCellValue(
  db: D1Database,
  workspaceId: string,
  field: Pick<FieldRow, "field_type" | "id">,
  fieldConfig: JsonValue,
  normalized: NormalizedCellValue | null
): Promise<void> {
  if (
    field.field_type !== "relation.record" ||
    normalized == null ||
    normalized.isEmpty ||
    !isRecord(fieldConfig) ||
    typeof fieldConfig.targetTableId !== "string" ||
    fieldConfig.targetTableId.trim() === ""
  ) {
    return;
  }

  const targetTableId = fieldConfig.targetTableId;
  const references = Array.isArray(normalized.raw)
    ? normalized.raw.filter((entry): entry is string => typeof entry === "string")
    : [];

  for (const recordId of references) {
    const relatedRecord = await getRecordById(db, workspaceId, recordId);
    if (!relatedRecord) {
      throw new CommandCommitError(
        `Expected relation.record reference ${recordId} to exist in table ${targetTableId}.`
      );
    }

    if (relatedRecord.table_id !== targetTableId) {
      throw new CommandCommitError(
        `Expected relation.record reference ${recordId} to belong to table ${targetTableId}, found ${relatedRecord.table_id}.`
      );
    }
  }
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
    field_order: field.field_order ?? null,
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

async function appendNonSelectFieldConfigStatements(
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
    const validation = definition.validateValue(stored, {
      fieldConfig,
      fieldType: field.field_type
    });
    if (!validation.valid) {
      throw new CommandCommitError(
        validation.errors[0] ?? `invalid_field_value:${field.field_type}`
      );
    }
    await validateCommittedCellValue(db, workspaceId, field, fieldConfig, stored);

    const nextIndex = definition.toIndex(stored, {
      fieldConfig,
      fieldType: field.field_type
    });
    const nextCell = buildCellStateRow(field, stored, nextIndex, row.cell_revision);

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

    if (!hasDependentIndexes || stored == null || stored.isEmpty) {
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

async function appendRecordPatchStatements(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  input: {
    command: EventLedgerCommit["command"];
    event: EventLedgerCommit["event"];
    patch: Record<string, unknown>;
    recordId: string;
    statements: D1PreparedStatement[];
    table: TableRow;
  }
): Promise<void> {
  const { command, event, patch, recordId, statements, table } = input;
  const record = await getRecord(db, command.workspaceId, table.id, recordId);
  if (!record) {
    throw new CommandCommitError(`record_not_found:${recordId}`);
  }

  const rowOwnerField = resolveRowOwnerField(await listFields(db, command.workspaceId, table.id));
  const fieldsByIdentifier = await resolvePatchFieldMap(db, command.workspaceId, table.id);
  const existingCells = await getRecordCells(db, command.workspaceId, table.id, recordId);
  const existingCellsByFieldId = new Map(existingCells.map((cell) => [cell.field_id, cell] as const));
  const mergedCellsByFieldId = new Map(existingCells.map((cell) => [cell.field_id, cell] as const));

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
    await validateCommittedCellValue(db, command.workspaceId, field, fieldConfig, normalized);

    const index = fieldType.toIndex(normalized, {
      fieldConfig,
      fieldType: field.field_type
    });
    const existingCell = existingCellsByFieldId.get(field.id) ?? null;
    const nextCellRevision = (existingCell?.cell_revision ?? 0) + 1;

    mergedCellsByFieldId.set(
      field.id,
      buildCellStateRow(field, normalized, index, nextCellRevision)
    );

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

  assertRowOwnerCellValue(rowOwnerField, mergedCellsByFieldId.get(rowOwnerField?.id ?? ""));

  const mergedCells = [...mergedCellsByFieldId.values()].sort(compareCellStateRows);
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
      const existingFields = await listFields(db, command.workspaceId, table.id);
      assertRowOwnerFieldConfiguration(existingFields, {
        candidateFieldId: fieldId,
        config,
        fieldType
      });
      await assertRowOwnerActivationInvariant(db, command.workspaceId, table.id, {
        activatingExistingField: false,
        fieldId,
        nextConfig: config
      });
      const orderedExistingFields = await appendDenseFieldOrderStatements(
        db,
        command.workspaceId,
        table.id,
        event,
        existingFields,
        statements
      );
      const fieldOrder = orderedExistingFields.length + 1;

      statements.push(
        db
          .prepare(
            `INSERT INTO fields (
              id,
              workspace_id,
              table_id,
              field_order,
              field_key,
              label,
              field_type,
              field_type_version,
              config_json,
              created_at,
              updated_at,
              archived_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            fieldId,
            command.workspaceId,
            table.id,
            fieldOrder,
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
      const existingFields = await listFields(db, command.workspaceId, table.id);
      const wasRowOwnerEnabled = isRowOwnerEnabled(existingConfig);
      assertRowOwnerFieldConfiguration(existingFields, {
        candidateFieldId: field.id,
        config: nextConfig,
        fieldType: field.field_type
      });
      await assertRowOwnerActivationInvariant(db, command.workspaceId, table.id, {
        activatingExistingField: !wasRowOwnerEnabled,
        fieldId: field.id,
        nextConfig
      });
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

      if (isSelectableOptionFieldType(field.field_type)) {
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
      } else {
        await appendNonSelectFieldConfigStatements(
          db,
          fieldTypeRegistry,
          command.workspaceId,
          table.id,
          field,
          nextConfig,
          event.eventId,
          statements
        );
      }
      return;
    }

    case "field.reorder": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const requestedFieldIds = Array.isArray(payload.fieldIds)
        ? payload.fieldIds.filter((fieldId): fieldId is string => typeof fieldId === "string")
        : [];
      const seenFieldIds = new Set<string>();
      for (const fieldId of requestedFieldIds) {
        if (seenFieldIds.has(fieldId)) {
          throw new CommandCommitError(`field_reorder_duplicate_field:${fieldId}`);
        }
        seenFieldIds.add(fieldId);
      }

      const activeFields = await listFields(db, command.workspaceId, table.id);
      const activeFieldIds = new Set(activeFields.map((field) => field.id));
      for (const fieldId of requestedFieldIds) {
        if (activeFieldIds.has(fieldId)) {
          continue;
        }
        const field = await findFieldAcrossWorkspace(db, command.workspaceId, fieldId);
        if (!field) {
          throw new CommandCommitError(`field_not_found:${fieldId}`);
        }
        if (field.table_id !== table.id) {
          throw new CommandCommitError(`field_reorder_cross_table_field:${fieldId}`);
        }
        if (field.archived_at !== null) {
          throw new CommandCommitError(`field_reorder_archived_field:${fieldId}`);
        }
        throw new CommandCommitError(`field_not_found:${fieldId}`);
      }

      const orderedActiveFields = [...activeFields].sort(compareFieldRows);
      if (requestedFieldIds.length !== orderedActiveFields.length) {
        const requestedFieldIdSet = new Set(requestedFieldIds);
        const missingField = orderedActiveFields.find((field) => !requestedFieldIdSet.has(field.id));
        if (missingField) {
          throw new CommandCommitError(`field_reorder_missing_field:${missingField.id}`);
        }
      }

      for (const [index, fieldId] of requestedFieldIds.entries()) {
        const nextOrder = index + 1;
        statements.push(
          db
            .prepare(
              `UPDATE fields
               SET field_order = ?, updated_at = ?, last_event_id = ?
               WHERE workspace_id = ? AND table_id = ? AND id = ?`
            )
            .bind(nextOrder, event.createdAt, event.eventId, command.workspaceId, table.id, fieldId)
        );
      }
      return;
    }

    case "field.archive": {
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

      statements.push(
        db
          .prepare(
            `UPDATE fields
             SET archived_at = ?, updated_at = ?, last_event_id = ?
             WHERE workspace_id = ? AND table_id = ? AND id = ?`
          )
          .bind(
            event.createdAt,
            event.createdAt,
            event.eventId,
            command.workspaceId,
            table.id,
            field.id
          )
      );
      statements.push(
        db
          .prepare(
            `DELETE FROM cell_current
             WHERE workspace_id = ? AND table_id = ? AND field_id = ?`
          )
          .bind(command.workspaceId, table.id, field.id)
      );
      statements.push(
        db
          .prepare(
            `DELETE FROM field_index_entries
             WHERE workspace_id = ? AND table_id = ? AND field_id = ?`
          )
          .bind(command.workspaceId, table.id, field.id)
      );
      await appendFieldArchiveProjectionStatements(
        db,
        command.workspaceId,
        table.id,
        field.field_key,
        event,
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
            : [
                "field.permission.configure",
                "record.create",
                "record.update",
                "records.bulk_patch",
                "record.archive",
                "cell.set"
              ],
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
      const activeFields = await listFields(db, command.workspaceId, table.id);
      assertWorkflowConditionBindings(
        definition,
        buildWorkflowAuthoringMetadataForFields(fieldTypeRegistry, activeFields)
      );
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

    case "workflow.update": {
      const workflowId = payload.workflowId as string;
      const workflowName = payload.name as string;
      const workflow = await getWorkflow(db, command.workspaceId, workflowId);
      if (!workflow) {
        throw new CommandCommitError(`workflow_not_found:${workflowId}`);
      }

      const currentVersion = await getCurrentWorkflowVersion(
        db,
        command.workspaceId,
        workflow.id,
        workflow.current_version
      );
      if (!currentVersion) {
        throw new CommandCommitError(
          `workflow_version_not_found:${workflowId}:v${workflow.current_version}`
        );
      }

      const currentDefinition = asWorkflowDefinition(JSON.parse(currentVersion.definition_json));
      if (!currentDefinition) {
        throw new CommandCommitError("workflow_definition_invalid");
      }

      const tableId =
        typeof payload.tableId === "string" && payload.tableId.length > 0
          ? (payload.tableId as string)
          : typeof currentDefinition.metadata?.tableId === "string" &&
              currentDefinition.metadata.tableId.length > 0
            ? (currentDefinition.metadata.tableId as string)
            : command.tableId;
      if (!tableId) {
        throw new CommandCommitError("missing_tableId");
      }

      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const nextDefinition = normalizeWorkflowDefinition(command, {
        ...payload,
        tableId
      });
      const activeFields = await listFields(db, command.workspaceId, table.id);
      assertWorkflowConditionBindings(
        nextDefinition,
        buildWorkflowAuthoringMetadataForFields(fieldTypeRegistry, activeFields)
      );
      const refs = workflowDefinitionRefs(nextDefinition);

      statements.push(
        db
          .prepare(
            `UPDATE workflows
             SET name = ?, updated_at = ?, last_event_id = ?, current_version = ?
             WHERE workspace_id = ? AND id = ?`
          )
          .bind(
            workflowName,
            event.createdAt,
            event.eventId,
            currentVersion.published_at == null ? workflow.current_version : workflow.current_version + 1,
            command.workspaceId,
            workflow.id
          )
      );

      if (currentVersion.published_at == null) {
        statements.push(
          db
            .prepare(
              `UPDATE workflow_versions
               SET definition_json = ?, last_event_id = ?
               WHERE workspace_id = ? AND id = ?`
            )
            .bind(
              toCanonicalJson(nextDefinition).trimEnd(),
              event.eventId,
              command.workspaceId,
              currentVersion.id
            ),
          db
            .prepare(`DELETE FROM workflow_operator_refs WHERE workspace_id = ? AND workflow_version_id = ?`)
            .bind(command.workspaceId, currentVersion.id)
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
                `${currentVersion.id}:op:${index}`,
                command.workspaceId,
                currentVersion.id,
                ref.operatorSlotKey,
                ref.operatorId,
                ref.operatorVersion,
                ref.configJson
              )
          );
        }
        return;
      }

      const nextVersionNumber = workflow.current_version + 1;
      const nextWorkflowVersionId = `${workflowId}:v${nextVersionNumber}`;
      statements.push(
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
            nextWorkflowVersionId,
            command.workspaceId,
            workflowId,
            nextVersionNumber,
            toCanonicalJson(nextDefinition).trimEnd(),
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
              `${nextWorkflowVersionId}:op:${index}`,
              command.workspaceId,
              nextWorkflowVersionId,
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
        const workflowTableId =
          typeof parsedDefinition.metadata?.tableId === "string" &&
          parsedDefinition.metadata.tableId.length > 0
            ? parsedDefinition.metadata.tableId
            : typeof parsedDefinition.trigger.match?.tableId === "string" &&
                parsedDefinition.trigger.match.tableId.length > 0
              ? parsedDefinition.trigger.match.tableId
            : null;
        if (!workflowTableId) {
          throw new CommandCommitError("missing_tableId");
        }

        const activeFields = await listFields(db, command.workspaceId, workflowTableId);
        assertWorkflowConditionBindings(
          parsedDefinition,
          buildWorkflowAuthoringMetadataForFields(fieldTypeRegistry, activeFields)
        );
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
      const activeFields = await listFields(db, command.workspaceId, table.id);
      const rowOwnerField = resolveRowOwnerField(activeFields);
      const effectiveCells = { ...cells };
      if (rowOwnerField && !Object.prototype.hasOwnProperty.call(effectiveCells, rowOwnerField.id)) {
        if (command.actor.principalId.length === 0) {
          throw new CommandCommitError(`row_owner_principal_missing:${rowOwnerField.id}`);
        }

        effectiveCells[rowOwnerField.id] = [command.actor.principalId];
      }

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
      const sortedFieldIds = Object.keys(effectiveCells).sort();
      let rowOwnerAssigned = rowOwnerField == null;
      for (const fieldId of sortedFieldIds) {
        const mutation = await buildCellMutation(
          db,
          fieldTypeRegistry,
          command.workspaceId,
          table.id,
          fieldId,
          effectiveCells[fieldId]
        );
        if (rowOwnerField && fieldId === rowOwnerField.id) {
          rowOwnerAssigned = mutation.normalized != null && !mutation.normalized.isEmpty;
        }

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
      if (!rowOwnerAssigned && rowOwnerField) {
        throw new CommandCommitError(`row_owner_value_required:${rowOwnerField.id}`);
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
      const patch =
        typeof payload.patch === "object" && payload.patch !== null && !Array.isArray(payload.patch)
          ? (payload.patch as Record<string, unknown>)
          : null;
      if (!patch) {
        throw new CommandCommitError("payload_patch_must_be_object");
      }

      await appendRecordPatchStatements(db, fieldTypeRegistry, {
        command,
        event,
        patch,
        recordId,
        statements,
        table
      });
      return;
    }

    case "records.bulk_patch": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const updates = Array.isArray(payload.updates) ? payload.updates : null;
      if (!updates || updates.length === 0) {
        throw new CommandCommitError("payload_updates_must_be_non_empty_array");
      }

      const seenRecordIds = new Set<string>();
      const sortedUpdates = [...updates].sort((left, right) => {
        const leftRecordId =
          typeof (left as Record<string, unknown>)?.recordId === "string"
            ? ((left as Record<string, unknown>).recordId as string)
            : "";
        const rightRecordId =
          typeof (right as Record<string, unknown>)?.recordId === "string"
            ? ((right as Record<string, unknown>).recordId as string)
            : "";
        return leftRecordId.localeCompare(rightRecordId);
      });

      for (const entry of sortedUpdates) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>).recordId !== "string"
        ) {
          throw new CommandCommitError("payload_updates_must_be_non_empty_array");
        }

        const recordId = (entry as Record<string, unknown>).recordId as string;
        if (seenRecordIds.has(recordId)) {
          throw new CommandCommitError(`duplicate_record_update:${recordId}`);
        }
        seenRecordIds.add(recordId);

        const patch =
          typeof (entry as Record<string, unknown>).patch === "object" &&
          (entry as Record<string, unknown>).patch !== null &&
          !Array.isArray((entry as Record<string, unknown>).patch)
            ? ((entry as Record<string, unknown>).patch as Record<string, unknown>)
            : null;
        if (!patch) {
          throw new CommandCommitError("payload_updates_must_be_non_empty_array");
        }

        await appendRecordPatchStatements(db, fieldTypeRegistry, {
          command,
          event,
          patch,
          recordId,
          statements,
          table
        });
      }
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
    case "view.update":
    case "view.delete": {
      const tableId = command.tableId as string;
      const table = await getTable(db, command.workspaceId, tableId);
      if (!table) {
        throw new CommandCommitError(`table_not_found:${tableId}`);
      }

      const viewId = payload.viewId as string;
      const existingView =
        command.commandType === "view.create"
          ? null
          : await getView(db, command.workspaceId, table.id, viewId);

      if ((command.commandType === "view.update" || command.commandType === "view.delete") && !existingView) {
        throw new CommandCommitError(`view_not_found:${viewId}`);
      }

      if (command.commandType === "view.delete") {
        statements.push(
          db
            .prepare(
              `UPDATE views
               SET updated_at = ?,
                   archived_at = ?,
                   last_event_id = ?
               WHERE workspace_id = ? AND table_id = ? AND id = ?`
            )
            .bind(
              event.createdAt,
              event.createdAt,
              event.eventId,
              command.workspaceId,
              table.id,
              viewId
            )
        );
        return;
      }

      const viewName = payload.viewName as string;
      const schemaInput = readViewSchemaPayload(payload);
      const viewKey =
        command.commandType === "view.create"
          ? typeof payload.viewKey === "string" && payload.viewKey.length > 0
            ? (payload.viewKey as string)
            : viewId.replace(/^view_/, "view-")
          : null;

      const fieldRows = await db
        .prepare(
          `SELECT id, field_type
           FROM fields
           WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
        )
        .bind(command.workspaceId, table.id)
        .all<Pick<FieldRow, "field_type" | "id">>();
      validateViewSchemaFieldCapabilities(
        fieldTypeRegistry,
        fieldRows.results ?? [],
        schemaInput
      );

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
      const rowOwnerField = resolveRowOwnerField(await listFields(db, command.workspaceId, table.id));

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
          field_order: mutation.field.field_order ?? null,
          field_key: mutation.field.field_key,
          value_json: JSON.stringify(mutation.normalized)
        }
      ].sort(compareCellStateRows);
      assertRowOwnerCellValue(
        rowOwnerField,
        mergedCells.find((cell) => cell.field_id === rowOwnerField?.id)
      );

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

    async listPendingOutboxEntries(input) {
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
           WHERE delivered_at IS NULL
             AND available_at <= ?
           ORDER BY available_at ASC, created_at ASC, outbox_id ASC
           LIMIT ?`
        )
        .bind(input.availableBefore, input.limit)
        .all<OutboxRow>();

      return rows.results ?? [];
    },

    async listTableActivity(input) {
      const recordIdSql = activityRecordIdSql("event_ledger");
      const rows = await db
        .prepare(
          `SELECT
             event_ledger.event_id,
             event_ledger.workspace_id,
             event_ledger.table_id,
             event_ledger.event_type,
             event_ledger.command_id,
             event_ledger.aggregate_id,
             event_ledger.workspace_sequence,
             event_ledger.table_sequence,
             event_ledger.created_at,
             json_extract(event_ledger.metadata_json, '$.commandType') AS command_type,
             json_extract(event_ledger.metadata_json, '$.aggregateType') AS aggregate_type,
             json_extract(event_ledger.metadata_json, '$.actor.mode') AS actor_mode,
             json_extract(event_ledger.metadata_json, '$.actor.principalId') AS actor_principal_id,
             ${recordIdSql} AS record_id,
             records.record_key AS record_key
           FROM event_ledger
           LEFT JOIN records
             ON records.workspace_id = event_ledger.workspace_id
            AND records.table_id = event_ledger.table_id
            AND records.id = ${recordIdSql}
           WHERE event_ledger.workspace_id = ?
             AND event_ledger.table_id = ?
             AND event_ledger.table_sequence IS NOT NULL
             AND (? IS NULL OR event_ledger.table_sequence < ?)
           ORDER BY event_ledger.table_sequence DESC, event_ledger.event_id DESC
           LIMIT ?`
        )
        .bind(
          input.workspaceId,
          input.tableId,
          input.beforeTableSequence ?? null,
          input.beforeTableSequence ?? null,
          input.limit
        )
        .all<ActivityHistoryRow>();

      return (rows.results ?? []).map(mapActivityHistoryRow);
    },

    async listWorkspaceActivity(input) {
      const recordIdSql = activityRecordIdSql("event_ledger");
      const rows = await db
        .prepare(
          `SELECT
             event_ledger.event_id,
             event_ledger.workspace_id,
             event_ledger.table_id,
             event_ledger.event_type,
             event_ledger.command_id,
             event_ledger.aggregate_id,
             event_ledger.workspace_sequence,
             event_ledger.table_sequence,
             event_ledger.created_at,
             json_extract(event_ledger.metadata_json, '$.commandType') AS command_type,
             json_extract(event_ledger.metadata_json, '$.aggregateType') AS aggregate_type,
             json_extract(event_ledger.metadata_json, '$.actor.mode') AS actor_mode,
             json_extract(event_ledger.metadata_json, '$.actor.principalId') AS actor_principal_id,
             ${recordIdSql} AS record_id,
             records.record_key AS record_key
           FROM event_ledger
           LEFT JOIN records
             ON records.workspace_id = event_ledger.workspace_id
            AND records.table_id = event_ledger.table_id
            AND records.id = ${recordIdSql}
           WHERE event_ledger.workspace_id = ?
             AND (? IS NULL OR event_ledger.workspace_sequence < ?)
           ORDER BY event_ledger.workspace_sequence DESC, event_ledger.event_id DESC
           LIMIT ?`
        )
        .bind(
          input.workspaceId,
          input.beforeWorkspaceSequence ?? null,
          input.beforeWorkspaceSequence ?? null,
          input.limit
        )
        .all<ActivityHistoryRow>();

      return (rows.results ?? []).map(mapActivityHistoryRow);
    },

    async listAppActivity(input) {
      const recordIdSql = activityRecordIdSql("event_ledger");
      const rows = await db
        .prepare(
          `SELECT
             event_ledger.event_id,
             event_ledger.workspace_id,
             event_ledger.table_id,
             event_ledger.event_type,
             event_ledger.command_id,
             event_ledger.aggregate_id,
             event_ledger.workspace_sequence,
             event_ledger.table_sequence,
             event_ledger.created_at,
             json_extract(event_ledger.metadata_json, '$.commandType') AS command_type,
             json_extract(event_ledger.metadata_json, '$.aggregateType') AS aggregate_type,
             json_extract(event_ledger.metadata_json, '$.actor.mode') AS actor_mode,
             json_extract(event_ledger.metadata_json, '$.actor.principalId') AS actor_principal_id,
             ${recordIdSql} AS record_id,
             records.record_key AS record_key
           FROM event_ledger
           INNER JOIN tables
             ON tables.workspace_id = event_ledger.workspace_id
            AND tables.id = event_ledger.table_id
           LEFT JOIN records
             ON records.workspace_id = event_ledger.workspace_id
            AND records.table_id = event_ledger.table_id
            AND records.id = ${recordIdSql}
           WHERE event_ledger.workspace_id = ?
             AND tables.app_id = ?
             AND (? IS NULL OR event_ledger.workspace_sequence < ?)
           ORDER BY event_ledger.workspace_sequence DESC, event_ledger.event_id DESC
           LIMIT ?`
        )
        .bind(
          input.workspaceId,
          input.appId,
          input.beforeWorkspaceSequence ?? null,
          input.beforeWorkspaceSequence ?? null,
          input.limit
        )
        .all<ActivityHistoryRow>();

      return (rows.results ?? []).map(mapActivityHistoryRow);
    },

    async listRecordActivity(input) {
      const recordIdSql = activityRecordIdSql("event_ledger");
      const rows = await db
        .prepare(
          `SELECT
             event_ledger.event_id,
             event_ledger.workspace_id,
             event_ledger.table_id,
             event_ledger.event_type,
             event_ledger.command_id,
             event_ledger.aggregate_id,
             event_ledger.workspace_sequence,
             event_ledger.table_sequence,
             event_ledger.created_at,
             json_extract(event_ledger.metadata_json, '$.commandType') AS command_type,
             json_extract(event_ledger.metadata_json, '$.aggregateType') AS aggregate_type,
             json_extract(event_ledger.metadata_json, '$.actor.mode') AS actor_mode,
             json_extract(event_ledger.metadata_json, '$.actor.principalId') AS actor_principal_id,
             ${recordIdSql} AS record_id,
             records.record_key AS record_key
           FROM event_ledger
           LEFT JOIN records
             ON records.workspace_id = event_ledger.workspace_id
            AND records.table_id = event_ledger.table_id
            AND records.id = ${recordIdSql}
           WHERE event_ledger.workspace_id = ?
             AND event_ledger.table_id = ?
             AND ${recordIdSql} = ?
             AND event_ledger.table_sequence IS NOT NULL
             AND (? IS NULL OR event_ledger.table_sequence < ?)
           ORDER BY event_ledger.table_sequence DESC, event_ledger.event_id DESC
           LIMIT ?`
        )
        .bind(
          input.workspaceId,
          input.tableId,
          input.recordId,
          input.beforeTableSequence ?? null,
          input.beforeTableSequence ?? null,
          input.limit
        )
        .all<ActivityHistoryRow>();

      return (rows.results ?? []).map(mapActivityHistoryRow);
    },

    async markOutboxEntryDelivered(input) {
      await db.batch([
        db
          .prepare(
            `UPDATE queue_outbox
             SET delivered_at = ?,
                 delivery_attempts = delivery_attempts + 1
             WHERE outbox_id = ?
               AND delivered_at IS NULL`
          )
          .bind(input.deliveredAt, input.outboxId)
      ]);
    },

    async recordOutboxPublishFailure(input) {
      await db.batch([
        db
          .prepare(
            `UPDATE queue_outbox
             SET available_at = ?,
                 delivery_attempts = delivery_attempts + 1
             WHERE outbox_id = ?
               AND delivered_at IS NULL`
          )
          .bind(input.nextAttemptAt, input.outboxId)
      ]);
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
              aggregateType: commit.event.aggregateType ?? null,
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
