import { createFieldTypeRegistry } from "../core/field-types/registry";
import type {
  FieldIndexValue,
  FieldTypeRegistry,
  JsonValue,
  NormalizedCellValue
} from "../core/field-types/types";
import type { CloudTableEnv, CloudTableQueueMessage } from "./env";

type EventRow = {
  created_at: string;
  event_id: string;
  payload_json: string;
  table_id: string | null;
  workspace_id: string;
  workspace_sequence: number;
};

type FieldRow = {
  config_json: string;
  field_key: string;
  field_type: string;
  id: string;
};

type ViewSchemaRow = {
  schema_json: string;
};

type CellRow = {
  field_id: string;
  value_json: string;
};

type ExistingIndexRow = {
  last_event_id: string;
  last_workspace_sequence: number | null;
};

type ParsedViewSchema = {
  filterFieldIds: string[];
  sortFieldIds: string[];
};

type ProjectionMaintenanceEvent = {
  createdAt: string;
  eventId: string;
  fieldId: string | null;
  recordId: string | null;
  tableId: string;
  workspaceId: string;
  workspaceSequence: number;
};

type SortColumnProjection = {
  isNull: boolean;
  sortBool: boolean | null;
  sortDatetime: string | null;
  sortNumber: number | null;
  sortText: string | null;
};

function parseEventRow(row: EventRow): ProjectionMaintenanceEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

  return {
    createdAt: row.created_at,
    eventId: row.event_id,
    fieldId: typeof payload.fieldId === "string" ? payload.fieldId : null,
    recordId: typeof payload.recordId === "string" ? payload.recordId : null,
    tableId: row.table_id ?? "",
    workspaceId: row.workspace_id,
    workspaceSequence: row.workspace_sequence
  };
}

function parseViewSchema(raw: string): ParsedViewSchema {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const asFieldIdArray = (key: string) =>
    Array.isArray(parsed[key])
      ? (parsed[key] as unknown[]).filter((value): value is string => typeof value === "string")
      : [];

  return {
    filterFieldIds: asFieldIdArray("filterFieldIds"),
    sortFieldIds: asFieldIdArray("sortFieldIds")
  };
}

function toNumberValue(indexValue: FieldIndexValue): number | null {
  if (indexValue.numberValue === undefined || indexValue.numberValue === null) {
    return null;
  }

  const parsed = Number(indexValue.numberValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveSortColumns(
  fieldTypeRegistry: FieldTypeRegistry,
  fieldType: string,
  fieldConfig: JsonValue,
  normalized: NormalizedCellValue | null
): SortColumnProjection {
  const definition = fieldTypeRegistry.require(fieldType);
  const indexValue = definition.toIndex(normalized, {
    fieldConfig,
    fieldType
  });
  const sortTextCandidate =
    indexValue.textValue ?? indexValue.referenceValue ?? indexValue.displayValue ?? null;
  const sortText =
    typeof sortTextCandidate === "string" && sortTextCandidate.length > 0
      ? sortTextCandidate
      : null;

  return {
    isNull: normalized == null || normalized.isEmpty,
    sortBool: indexValue.boolValue ?? null,
    sortDatetime: indexValue.datetimeValue ?? null,
    sortNumber: toNumberValue(indexValue),
    sortText
  };
}

async function loadEvent(
  db: D1Database,
  workspaceId: string,
  eventId: string
): Promise<ProjectionMaintenanceEvent | null> {
  const row = await db
    .prepare(
      `SELECT
         event_id,
         workspace_id,
         table_id,
         payload_json,
         created_at,
         workspace_sequence
       FROM event_ledger
       WHERE workspace_id = ? AND event_id = ?`
    )
    .bind(workspaceId, eventId)
    .first<EventRow>();

  if (!row || !row.table_id) {
    return null;
  }

  return parseEventRow(row);
}

async function loadIndexableFields(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  workspaceId: string,
  tableId: string
): Promise<Map<string, FieldRow>> {
  const fieldRows = await db
    .prepare(
      `SELECT id, field_key, field_type, config_json
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL
       ORDER BY
         CASE WHEN field_order IS NULL THEN 0 ELSE 1 END ASC,
         CASE WHEN field_order IS NULL THEN created_at ELSE NULL END ASC,
         CASE WHEN field_order IS NULL THEN id ELSE NULL END ASC,
         field_order ASC,
         id ASC`
    )
    .bind(workspaceId, tableId)
    .all<FieldRow>();
  const fields = fieldRows.results ?? [];

  const viewRows = await db
    .prepare(
      `SELECT view_schema_versions.schema_json
       FROM views
       INNER JOIN view_schema_versions
         ON view_schema_versions.workspace_id = views.workspace_id
        AND view_schema_versions.view_id = views.id
        AND view_schema_versions.schema_version = views.current_schema_version
       WHERE views.workspace_id = ? AND views.table_id = ? AND views.archived_at IS NULL`
    )
    .bind(workspaceId, tableId)
    .all<ViewSchemaRow>();

  const dependentFieldIds = new Set<string>();
  for (const row of viewRows.results ?? []) {
    const schema = parseViewSchema(row.schema_json);
    for (const fieldId of [...schema.filterFieldIds, ...schema.sortFieldIds]) {
      dependentFieldIds.add(fieldId);
    }
  }

  return new Map(
    fields
      .filter((field) => {
        if (!dependentFieldIds.has(field.id)) {
          return false;
        }

        const definition = fieldTypeRegistry.require(field.field_type);
        return (
          definition.capabilities.supportsFiltering ||
          definition.capabilities.supportsSorting
        );
      })
      .map((field) => [field.id, field] as const)
  );
}

async function loadRecordCells(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  recordId: string
): Promise<Map<string, NormalizedCellValue | null>> {
  const record = await db
    .prepare(
      `SELECT id
       FROM records
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, recordId)
    .first<{ id: string }>();

  if (!record) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT field_id, value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
    )
    .bind(workspaceId, tableId, recordId)
    .all<CellRow>();

  return new Map(
    (rows.results ?? []).map((row) => [
      row.field_id,
      JSON.parse(row.value_json) as NormalizedCellValue | null
    ])
  );
}

async function loadExistingIndexEntry(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  fieldId: string,
  recordId: string
): Promise<ExistingIndexRow | null> {
  return db
    .prepare(
      `SELECT
         field_index_entries.last_event_id AS last_event_id,
         event_ledger.workspace_sequence AS last_workspace_sequence
       FROM field_index_entries
       LEFT JOIN event_ledger
         ON event_ledger.event_id = field_index_entries.last_event_id
       WHERE field_index_entries.workspace_id = ?
         AND field_index_entries.table_id = ?
         AND field_index_entries.field_id = ?
         AND field_index_entries.record_id = ?`
    )
    .bind(workspaceId, tableId, fieldId, recordId)
    .first<ExistingIndexRow>();
}

async function deleteIndexEntry(
  db: D1Database,
  event: ProjectionMaintenanceEvent,
  fieldId: string
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ? AND field_id = ? AND record_id = ?`
      )
      .bind(event.workspaceId, event.tableId, fieldId, event.recordId)
  ]);
}

async function upsertIndexEntry(
  db: D1Database,
  event: ProjectionMaintenanceEvent,
  fieldId: string,
  projection: SortColumnProjection
): Promise<void> {
  await db.batch([
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
        event.workspaceId,
        event.tableId,
        fieldId,
        event.recordId,
        projection.sortText,
        projection.sortNumber,
        projection.sortDatetime,
        projection.sortBool == null ? null : projection.sortBool ? 1 : 0,
        event.eventId
      )
  ]);
}

export async function shouldEnqueueProjectionMaintenance(
  db: D1Database,
  workspaceId: string,
  eventId: string
): Promise<boolean> {
  const event = await loadEvent(db, workspaceId, eventId);
  return Boolean(event?.recordId && event.tableId);
}

export async function processProjectionMaintenanceMessage(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const eventId =
    typeof message.eventId === "string"
      ? message.eventId
      : typeof message.payload.eventId === "string"
        ? message.payload.eventId
        : null;
  if (!eventId) {
    return;
  }

  const event = await loadEvent(env.DB, message.workspaceId, eventId);
  if (!event?.recordId) {
    return;
  }

  const fieldTypeRegistry = createFieldTypeRegistry();
  const indexableFields = await loadIndexableFields(
    env.DB,
    fieldTypeRegistry,
    event.workspaceId,
    event.tableId
  );
  const targetedFieldIds = event.fieldId
    ? [event.fieldId]
    : Array.from(indexableFields.keys());
  const cells = await loadRecordCells(env.DB, event.workspaceId, event.tableId, event.recordId);

  for (const fieldId of targetedFieldIds) {
    const existing = await loadExistingIndexEntry(
      env.DB,
      event.workspaceId,
      event.tableId,
      fieldId,
      event.recordId
    );
    if (
      existing?.last_workspace_sequence != null &&
      existing.last_workspace_sequence > event.workspaceSequence
    ) {
      continue;
    }

    const field = indexableFields.get(fieldId);
    if (!field) {
      await deleteIndexEntry(env.DB, event, fieldId);
      continue;
    }

    const projection = deriveSortColumns(
      fieldTypeRegistry,
      field.field_type,
      JSON.parse(field.config_json) as JsonValue,
      cells.get(fieldId) ?? null
    );

    if (projection.isNull) {
      await deleteIndexEntry(env.DB, event, fieldId);
      continue;
    }

    await upsertIndexEntry(env.DB, event, fieldId, projection);
  }
}
