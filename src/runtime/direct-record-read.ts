type ProjectionRow = {
  projection_json: string;
  projection_version: number;
  last_event_id: string;
  updated_at: string;
};

type RecordRow = {
  id: string;
  record_key: string;
  record_revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  last_event_id: string | null;
};

type RecordFieldRow = {
  field_key: string;
  field_order: number | null;
  field_type: string;
  id: string;
};

export async function readRecordDetail(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  recordId: string
): Promise<{
  record: RecordRow;
  projection: ProjectionRow | null;
} | null> {
  const record = await db
    .prepare(
      `SELECT
         id,
         record_key,
         record_revision,
         created_at,
         updated_at,
         archived_at,
         last_event_id
       FROM records
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, recordId)
    .first<RecordRow>();

  if (!record) {
    return null;
  }

  const projection = await db
    .prepare(
      `SELECT
         projection_json,
         projection_version,
         last_event_id,
         updated_at
       FROM record_projection
       WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
    )
    .bind(workspaceId, tableId, recordId)
    .first<ProjectionRow>();

  return {
    projection: projection ?? null,
    record
  };
}

export async function readRecordFields(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<RecordFieldRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, field_key, field_type, field_order
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
    .all<RecordFieldRow>();

  return rows.results ?? [];
}
