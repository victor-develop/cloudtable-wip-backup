import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type QueryResults<T> = {
  results: T[];
};

type SqlParameter = string | number | bigint | Uint8Array | DataView | null;

class SqliteD1BoundStatement {
  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
    private readonly params: SqlParameter[]
  ) {}

  async all<T>(): Promise<QueryResults<T>> {
    return {
      results: this.statement.all(...(this.params as Parameters<StatementSync["all"]>)) as T[]
    };
  }

  async first<T>(): Promise<T | null> {
    const row = this.statement.get(...(this.params as Parameters<StatementSync["get"]>)) as
      | T
      | undefined;
    return row ?? null;
  }

  execute(): QueryResults<unknown> {
    const sql = this.sql.trimStart().toUpperCase();

    if (
      sql.startsWith("INSERT") ||
      sql.startsWith("UPDATE") ||
      sql.startsWith("DELETE") ||
      sql.startsWith("CREATE") ||
      sql.startsWith("DROP") ||
      sql.startsWith("ALTER")
    ) {
      this.statement.run(...(this.params as Parameters<StatementSync["run"]>));
      return {
        results: []
      };
    }

    return {
      results: this.statement.all(...(this.params as Parameters<StatementSync["all"]>))
    };
  }
}

class SqliteD1PreparedStatement {
  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync
  ) {}

  bind(...params: SqlParameter[]): SqliteD1BoundStatement {
    return new SqliteD1BoundStatement(this.sql, this.statement, params);
  }
}

export class SqliteD1Database {
  readonly inner = new DatabaseSync(":memory:");

  constructor() {
    this.inner.exec(
      readFileSync(resolve(process.cwd(), "migrations/0001_initial_schema.sql"), "utf8")
    );
  }

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(sql, this.inner.prepare(sql));
  }

  async batch(statements: Array<SqliteD1BoundStatement>): Promise<Array<QueryResults<unknown>>> {
    this.inner.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.inner.exec("COMMIT");
      return results;
    } catch (error) {
      this.inner.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }
}

export function seedWorkspace(db: SqliteD1Database, workspaceId = "ws_1"): void {
  db.inner
    .prepare(
      `INSERT INTO workspaces (
        id,
        slug,
        name,
        created_at,
        updated_at,
        archived_at,
        last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      workspaceId,
      `workspace-${workspaceId}`,
      `Workspace ${workspaceId}`,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );
}

export function seedAppAndTable(
  db: SqliteD1Database,
  options: {
    appId?: string;
    tableId?: string;
    workspaceId?: string;
  } = {}
): { appId: string; tableId: string; workspaceId: string } {
  const workspaceId = options.workspaceId ?? "ws_1";
  const appId = options.appId ?? "app_1";
  const tableId = options.tableId ?? "tbl_1";

  db.inner
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
    .run(
      appId,
      workspaceId,
      "app-1",
      "App 1",
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );

  db.inner
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
    .run(
      tableId,
      workspaceId,
      appId,
      "table-1",
      "Table 1",
      0,
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );

  return { appId, tableId, workspaceId };
}

export function insertField(
  db: SqliteD1Database,
  input: {
    config?: Record<string, unknown>;
    fieldId: string;
    fieldOrder?: number | null;
    fieldKey: string;
    fieldType: string;
    label: string;
    tableId: string;
    workspaceId?: string;
  }
): void {
  db.inner
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
    .run(
      input.fieldId,
      input.workspaceId ?? "ws_1",
      input.tableId,
      input.fieldOrder ?? null,
      input.fieldKey,
      input.label,
      input.fieldType,
      1,
      JSON.stringify(input.config ?? {}),
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );
}

export function insertRecord(
  db: SqliteD1Database,
  input: {
    archivedAt?: string | null;
    lastEventId?: string | null;
    recordId: string;
    recordKey: string;
    recordRevision?: number;
    tableId: string;
    workspaceId?: string;
  }
): void {
  db.inner
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
    .run(
      input.recordId,
      input.workspaceId ?? "ws_1",
      input.tableId,
      input.recordKey,
      input.recordRevision ?? 1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      input.archivedAt ?? null,
      input.lastEventId ?? null
    );
}
