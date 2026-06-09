import type { JsonValue } from "../core/field-types/types";

type TableRow = {
  app_id: string;
  current_schema_version: number;
  id: string;
  name: string;
  schema_epoch: number;
  slug: string;
};

type FieldRow = {
  config_json: string;
  created_at: string;
  field_key: string;
  field_order: number | null;
  field_type: string;
  field_type_version: number;
  id: string;
  label: string;
};

type ViewRow = {
  current_schema_version: number;
  id: string;
  name: string;
  schema_json: string;
  table_id: string;
  view_key: string;
};

export type TableSchemaMetadata = {
  appId: string;
  fields: Array<{
    config: JsonValue;
    fieldId: string;
    fieldKey: string;
    fieldType: string;
    fieldTypeVersion: number;
    label: string;
  }>;
  schemaEpoch: number;
  tableId: string;
  tableName: string;
  tableSchemaVersion: number;
  tableSlug: string;
  workspaceId: string;
};

export type ViewDefinitionMetadata = {
  definition: {
    filterFieldIds: string[];
    filters: Array<{
      comparator?: string;
      fieldId: string;
      operatorId: string;
      value?: JsonValue;
    }>;
    groupByFieldId: string | null;
    showEmptyGroups: boolean;
    sortFieldIds: string[];
    sorts: Array<{
      fieldId: string;
      mode: string;
    }>;
    visibleFieldIds: string[];
  };
  tableId: string;
  viewId: string;
  viewKey: string;
  viewName: string;
  viewSchemaVersion: number;
  workspaceId: string;
};

export class SchemaMetadataAccessError extends Error {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "SchemaMetadataAccessError";
    this.details = details ?? null;
  }
}

export async function readTableSchemaMetadata(
  db: D1Database,
  input: {
    tableId: string;
    workspaceId: string;
  }
): Promise<TableSchemaMetadata | null> {
  const table = await db
    .prepare(
      `SELECT id, app_id, slug, name, schema_epoch, current_schema_version
       FROM tables
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.tableId)
    .first<TableRow>();

  if (!table) {
    return null;
  }

  const fieldRows = await db
    .prepare(
      `SELECT
         id,
         field_key,
         label,
         field_type,
         field_type_version,
         config_json,
         created_at,
         field_order
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

  return {
    appId: table.app_id,
    fields: (fieldRows.results ?? []).map((field) => ({
      config: JSON.parse(field.config_json) as JsonValue,
      fieldId: field.id,
      fieldKey: field.field_key,
      fieldType: field.field_type,
      fieldTypeVersion: field.field_type_version,
      label: field.label
    })),
    schemaEpoch: table.schema_epoch,
    tableId: table.id,
    tableName: table.name,
    tableSchemaVersion: table.current_schema_version,
    tableSlug: table.slug,
    workspaceId: input.workspaceId
  };
}

export async function readViewDefinitionMetadata(
  db: D1Database,
  input: {
    tableId: string;
    viewId: string;
    workspaceId: string;
  }
): Promise<ViewDefinitionMetadata | null> {
  const row = await db
    .prepare(
      `SELECT
         views.id,
         views.table_id,
         views.view_key,
         views.name,
         views.current_schema_version,
         view_schema_versions.schema_json
       FROM views
       INNER JOIN view_schema_versions
         ON view_schema_versions.workspace_id = views.workspace_id
        AND view_schema_versions.view_id = views.id
        AND view_schema_versions.schema_version = views.current_schema_version
       WHERE views.workspace_id = ?
         AND views.table_id = ?
         AND views.id = ?
         AND views.archived_at IS NULL`
    )
    .bind(input.workspaceId, input.tableId, input.viewId)
    .first<ViewRow>();

  if (!row) {
    return null;
  }

  const parsed = JSON.parse(row.schema_json) as Record<string, unknown>;
  const asFieldIdArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const filters = Array.isArray(parsed.filters)
    ? parsed.filters
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            typeof entry.fieldId === "string" &&
            typeof entry.operatorId === "string"
        )
        .map((entry) => ({
          comparator: typeof entry.comparator === "string" ? entry.comparator : undefined,
          fieldId: entry.fieldId as string,
          operatorId: entry.operatorId as string,
          value: entry.value as JsonValue | undefined
        }))
    : [];
  const filterFieldIds =
    filters.length > 0 ? filters.map((filter) => filter.fieldId) : asFieldIdArray(parsed.filterFieldIds);
  const sorts = Array.isArray(parsed.sorts)
    ? parsed.sorts
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            typeof entry.fieldId === "string"
        )
        .map((entry) => ({
          fieldId: entry.fieldId as string,
          mode: typeof entry.mode === "string" ? entry.mode : "ascending"
        }))
    : [];
  const sortFieldIds =
    sorts.length > 0 ? sorts.map((sort) => sort.fieldId) : asFieldIdArray(parsed.sortFieldIds);

  return {
    definition: {
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
      visibleFieldIds: asFieldIdArray(parsed.visibleFieldIds)
    },
    tableId: row.table_id,
    viewId: row.id,
    viewKey: row.view_key,
    viewName: row.name,
    viewSchemaVersion: row.current_schema_version,
    workspaceId: input.workspaceId
  };
}
