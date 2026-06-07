import type { WorkspaceInspection, WorkspaceInspector } from "../core/agent-tools/types";
import type { FieldTypeRegistry } from "../core/field-types/types";
import type { WorkflowOperatorRegistry } from "../core/workflows/types";

type AppRow = {
  app_id: string;
  app_name: string;
  created_at: string;
};

type TableRow = {
  table_id: string;
  app_id: string;
  table_name: string;
  created_at: string;
};

type FieldRow = {
  field_id: string;
  table_id: string;
  created_at: string;
};

type ViewRow = {
  view_id: string;
  table_id: string;
  view_name: string;
  created_at: string;
};

type WorkflowRow = {
  workflow_id: string;
  workflow_name: string;
  definition_json: string;
  published_at: string | null;
  created_at: string;
};

export function createWorkspaceInspector(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  workflowOperatorRegistry: WorkflowOperatorRegistry
): WorkspaceInspector {
  return {
    async inspect(input) {
      const include = new Set(input.include ?? ["apps", "tables", "views", "workflows", "catalog"]);
      const appsIncluded = include.has("apps");
      const tablesIncluded = include.has("tables");
      const viewsIncluded = include.has("views");
      const workflowsIncluded = include.has("workflows");
      const catalogIncluded = include.has("catalog");

      const [apps, tables, fieldsByTableId, viewIdsByTableId, views, workflows] = await Promise.all([
        appsIncluded ? loadApps(db, input.workspaceId) : Promise.resolve([]),
        appsIncluded || tablesIncluded ? loadTables(db, input.workspaceId) : Promise.resolve([]),
        tablesIncluded ? loadFieldIdsByTable(db, input.workspaceId) : Promise.resolve(new Map()),
        tablesIncluded ? loadViewIdsByTable(db, input.workspaceId) : Promise.resolve(new Map()),
        viewsIncluded ? loadViews(db, input.workspaceId) : Promise.resolve([]),
        workflowsIncluded ? loadWorkflows(db, input.workspaceId) : Promise.resolve([])
      ]);

      const tableIdsByAppId = buildTableIdsByAppId(tables);

      return {
        apps: appsIncluded
          ? apps.map((app) => ({
              appId: app.app_id,
              name: app.app_name,
              tableIds: tableIdsByAppId.get(app.app_id) ?? []
            }))
          : [],
        catalog: catalogIncluded
          ? {
              fieldTypes: fieldTypeRegistry.list().map((fieldType) => fieldType.type),
              workflowOperators: workflowOperatorRegistry.list().map((operator) => ({
                id: operator.id,
                kind: operator.kind,
                requiredCapabilities: operator.requiredCapabilities
              }))
            }
          : undefined,
        tables: tablesIncluded
          ? tables.map((table) => ({
              fieldIds: fieldsByTableId.get(table.table_id) ?? [],
              name: table.table_name,
              tableId: table.table_id,
              viewIds: viewIdsByTableId.get(table.table_id) ?? []
            }))
          : [],
        views: viewsIncluded
          ? views.map((view) => ({
              name: view.view_name,
              tableId: view.table_id,
              viewId: view.view_id
            }))
          : [],
        workflows: workflowsIncluded
          ? workflows.map((workflow) => ({
              name: workflow.workflow_name,
              status: inferWorkflowStatus(workflow),
              tableId: extractWorkflowTableId(workflow.definition_json),
              workflowId: workflow.workflow_id
            }))
          : [],
        workspaceId: input.workspaceId
      } satisfies WorkspaceInspection;
    }
  };
}

async function loadApps(db: D1Database, workspaceId: string): Promise<AppRow[]> {
  const rows = await db
    .prepare(
      `SELECT id AS app_id, name AS app_name, created_at
       FROM apps
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY created_at ASC, id ASC`
    )
    .bind(workspaceId)
    .all<AppRow>();

  return rows.results ?? [];
}

async function loadTables(db: D1Database, workspaceId: string): Promise<TableRow[]> {
  const rows = await db
    .prepare(
      `SELECT id AS table_id, app_id, name AS table_name, created_at
       FROM tables
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY created_at ASC, id ASC`
    )
    .bind(workspaceId)
    .all<TableRow>();

  return rows.results ?? [];
}

async function loadFieldIdsByTable(
  db: D1Database,
  workspaceId: string
): Promise<Map<string, string[]>> {
  const rows = await db
    .prepare(
      `SELECT id AS field_id, table_id, created_at
       FROM fields
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY created_at ASC, id ASC`
    )
    .bind(workspaceId)
    .all<FieldRow>();

  return groupIdsByTable(rows.results ?? [], "field_id");
}

async function loadViewIdsByTable(db: D1Database, workspaceId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .prepare(
      `SELECT id AS view_id, table_id, created_at
       FROM views
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY created_at ASC, id ASC`
    )
    .bind(workspaceId)
    .all<ViewRow>();

  return groupIdsByTable(rows.results ?? [], "view_id");
}

async function loadViews(db: D1Database, workspaceId: string): Promise<ViewRow[]> {
  const rows = await db
    .prepare(
      `SELECT id AS view_id, table_id, name AS view_name, created_at
       FROM views
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY created_at ASC, id ASC`
    )
    .bind(workspaceId)
    .all<ViewRow>();

  return rows.results ?? [];
}

async function loadWorkflows(db: D1Database, workspaceId: string): Promise<WorkflowRow[]> {
  const rows = await db
    .prepare(
      `SELECT
         workflows.id AS workflow_id,
         workflows.name AS workflow_name,
         workflows.created_at AS created_at,
         workflow_versions.definition_json AS definition_json,
         workflow_versions.published_at AS published_at
       FROM workflows
       INNER JOIN workflow_versions
         ON workflow_versions.workflow_id = workflows.id
        AND workflow_versions.workspace_id = workflows.workspace_id
        AND workflow_versions.version = workflows.current_version
       WHERE workflows.workspace_id = ?
         AND workflows.archived_at IS NULL
       ORDER BY workflows.created_at ASC, workflows.id ASC`
    )
    .bind(workspaceId)
    .all<WorkflowRow>();

  return rows.results ?? [];
}

function buildTableIdsByAppId(tables: TableRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const table of tables) {
    const existing = grouped.get(table.app_id);
    if (existing) {
      existing.push(table.table_id);
      continue;
    }

    grouped.set(table.app_id, [table.table_id]);
  }

  return grouped;
}

function groupIdsByTable<T extends { table_id: string }>(
  rows: T[],
  idKey: keyof T
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const id = row[idKey];
    if (typeof id !== "string") {
      continue;
    }

    const existing = grouped.get(row.table_id);
    if (existing) {
      existing.push(id);
      continue;
    }

    grouped.set(row.table_id, [id]);
  }

  return grouped;
}

function extractWorkflowTableId(definitionJson: string): string {
  let definition: Record<string, unknown> | null = null;
  try {
    definition = JSON.parse(definitionJson) as Record<string, unknown>;
  } catch {
    return "";
  }

  const trigger = asRecord(definition.trigger);
  const triggerMatch = asRecord(trigger?.match);
  if (typeof triggerMatch?.tableId === "string") {
    return triggerMatch.tableId;
  }

  if (typeof trigger?.tableId === "string") {
    return trigger.tableId;
  }

  const actions = Array.isArray(definition.actions) ? definition.actions : [];
  for (const action of actions) {
    const input = asRecord(asRecord(action)?.input);
    if (typeof input?.tableId === "string") {
      return input.tableId;
    }
  }

  return "";
}

function inferWorkflowStatus(workflow: WorkflowRow): "draft" | "published" | "paused" {
  const metadataStatus = readWorkflowStatusFromDefinition(workflow.definition_json);
  if (metadataStatus) {
    return metadataStatus;
  }

  return workflow.published_at == null ? "draft" : "published";
}

function readWorkflowStatusFromDefinition(
  definitionJson: string
): "draft" | "published" | "paused" | null {
  let definition: Record<string, unknown> | null = null;
  try {
    definition = JSON.parse(definitionJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  for (const candidate of [
    definition.status,
    definition.state,
    asRecord(definition.metadata)?.status,
    asRecord(definition.runtime)?.status
  ]) {
    if (candidate === "draft" || candidate === "published" || candidate === "paused") {
      return candidate;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
