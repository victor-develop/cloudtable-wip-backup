import type { AppInspection, AppInspector } from "../core/agent-tools/types";

type AppRow = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
};

type TableRow = {
  id: string;
};

export function createAppInspector(db: D1Database): AppInspector {
  return {
    async inspect(input): Promise<AppInspection | null> {
      const app = await db
        .prepare(
          `SELECT id, name, slug, created_at, updated_at
           FROM apps
           WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
        )
        .bind(input.workspaceId, input.appId)
        .first<AppRow>();

      if (!app) {
        return null;
      }

      const tables = await db
        .prepare(
          `SELECT id
           FROM tables
           WHERE workspace_id = ? AND app_id = ? AND archived_at IS NULL
           ORDER BY created_at ASC, id ASC`
        )
        .bind(input.workspaceId, input.appId)
        .all<TableRow>();
      const tableIds = (tables.results ?? []).map((table) => table.id);

      return {
        appId: app.id,
        createdAt: app.created_at,
        name: app.name,
        slug: app.slug,
        tableCount: tableIds.length,
        tableIds,
        updatedAt: app.updated_at,
        workspaceId: input.workspaceId
      };
    }
  };
}
