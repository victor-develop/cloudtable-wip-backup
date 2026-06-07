import type { FieldTypeRegistry } from "../core/field-types/types";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";

type PermissionSnapshotRow = {
  policy_revision: number;
  snapshot_json: string;
};

type TableSchemaRow = {
  schema_epoch: number;
};

type FieldRow = {
  config_json: string;
  field_type: string;
  id: string;
};

type PermissionPolicyRow = {
  revision: number;
};

type PermissionResolutionScope =
  | {
      kind: "workspace";
    }
  | {
      kind: "table";
      tableId: string;
    }
  | {
      kind: "view";
      tableId: string;
      viewId: string;
    };

export type ResolvePermissionSnapshotInput = {
  fieldTypeRegistry: FieldTypeRegistry;
  permissionScopeHash?: string | null;
  policyRevision?: number | null;
  principalId: string;
  scope: PermissionResolutionScope;
  workspaceId: string;
};

export type ResolvePermissionSnapshotResult =
  | {
      ok: true;
      snapshot: EffectivePermissionSnapshot;
    }
  | {
      message: string;
      ok: false;
    };

export async function readPermissionSnapshot(
  db: D1Database,
  input: {
    permissionScopeHash?: string | null;
    policyRevision?: number | null;
    principalId?: string | null;
    workspaceId: string;
  }
): Promise<EffectivePermissionSnapshot | undefined> {
  if (
    !input.principalId ||
    typeof input.policyRevision !== "number" ||
    !input.permissionScopeHash
  ) {
    return undefined;
  }

  const row = await db
    .prepare(
      `SELECT snapshot_json
       FROM permission_snapshots
       WHERE workspace_id = ? AND principal_id = ? AND policy_revision = ? AND scope_hash = ?`
    )
    .bind(
      input.workspaceId,
      input.principalId,
      input.policyRevision,
      input.permissionScopeHash
    )
    .first<PermissionSnapshotRow>();

  return row ? (JSON.parse(row.snapshot_json) as EffectivePermissionSnapshot) : undefined;
}

export async function readLatestPermissionSnapshotForScope(
  db: D1Database,
  input: {
    permissionScopeHash?: string | null;
    principalId?: string | null;
    workspaceId: string;
  }
): Promise<EffectivePermissionSnapshot | undefined> {
  if (!input.principalId || !input.permissionScopeHash) {
    return undefined;
  }

  return readLatestPermissionSnapshot(db, {
    permissionScopeHash: input.permissionScopeHash,
    principalId: input.principalId,
    workspaceId: input.workspaceId
  });
}

export async function resolvePermissionSnapshot(
  db: D1Database,
  input: ResolvePermissionSnapshotInput
): Promise<ResolvePermissionSnapshotResult> {
  const resolvedScopeHash = buildPermissionScopeHash(input.scope);
  const snapshot =
    (await readLatestPermissionSnapshot(db, {
      permissionScopeHash: resolvedScopeHash,
      principalId: input.principalId,
      workspaceId: input.workspaceId
    })) ??
    (await materializePermissionSnapshot(db, {
      fieldTypeRegistry: input.fieldTypeRegistry,
      principalId: input.principalId,
      scope: input.scope,
      workspaceId: input.workspaceId
    }));

  if (!snapshot) {
    return {
      message: "Permission snapshot could not be resolved for this request scope.",
      ok: false
    };
  }

  if (
    typeof input.permissionScopeHash === "string" &&
    input.permissionScopeHash.length > 0 &&
    input.permissionScopeHash !== snapshot.scopeHash
  ) {
    return {
      message: `Requested permissionScopeHash ${input.permissionScopeHash} does not match resolved scope ${snapshot.scopeHash}.`,
      ok: false
    };
  }

  if (
    typeof input.policyRevision === "number" &&
    Number.isFinite(input.policyRevision) &&
    input.policyRevision !== snapshot.policyRevision
  ) {
    return {
      message: `Requested policyRevision ${input.policyRevision} does not match resolved revision ${snapshot.policyRevision}.`,
      ok: false
    };
  }

  return {
    ok: true,
    snapshot
  };
}

async function readLatestPermissionSnapshot(
  db: D1Database,
  input: {
    permissionScopeHash: string;
    principalId: string;
    workspaceId: string;
  }
): Promise<EffectivePermissionSnapshot | undefined> {
  const row = await db
    .prepare(
      `SELECT snapshot_json, policy_revision
       FROM permission_snapshots
       WHERE workspace_id = ? AND principal_id = ? AND scope_hash = ?
       ORDER BY policy_revision DESC
       LIMIT 1`
    )
    .bind(input.workspaceId, input.principalId, input.permissionScopeHash)
    .first<PermissionSnapshotRow>();

  return row ? (JSON.parse(row.snapshot_json) as EffectivePermissionSnapshot) : undefined;
}

function buildPermissionScopeHash(scope: PermissionResolutionScope): string {
  switch (scope.kind) {
    case "workspace":
      return "scope:workspace";
    case "table":
      return `scope:table:${scope.tableId}`;
    case "view":
      return `scope:view:${scope.viewId}`;
  }
}

async function materializePermissionSnapshot(
  db: D1Database,
  input: {
    fieldTypeRegistry: FieldTypeRegistry;
    principalId: string;
    scope: PermissionResolutionScope;
    workspaceId: string;
  }
): Promise<EffectivePermissionSnapshot | undefined> {
  const policyRevision = await readLatestPolicyRevision(
    db,
    input.workspaceId,
    input.principalId,
    input.scope
  );

  if (input.scope.kind === "workspace") {
    return {
      fields: {},
      policyRevision,
      principalId: input.principalId,
      schemaEpoch: 0,
      scopeHash: buildPermissionScopeHash(input.scope),
      snapshotId: `resolved:${input.workspaceId}:${input.principalId}:workspace:${policyRevision}`,
      workspaceId: input.workspaceId
    };
  }

  const table = await db
    .prepare(
      `SELECT schema_epoch
       FROM tables
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.scope.tableId)
    .first<TableSchemaRow>();

  if (!table) {
    return undefined;
  }

  const fieldRows = await db
    .prepare(
      `SELECT id, field_type, config_json
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.scope.tableId)
    .all<FieldRow>();

  const fields = Object.fromEntries(
    (fieldRows.results ?? []).map((field) => {
      const definition = input.fieldTypeRegistry.require(field.field_type);
      const behavior = definition.getPermissionBehavior({
        fieldType: field.field_type
      });
      const config = JSON.parse(field.config_json) as {
        permissionsByPrincipal?: Record<string, unknown>;
      };
      const explicit =
        typeof config.permissionsByPrincipal === "object" &&
        config.permissionsByPrincipal !== null &&
        !Array.isArray(config.permissionsByPrincipal)
          ? (config.permissionsByPrincipal[input.principalId] as
              | {
                  agent?: boolean;
                  read?: "visible" | "redacted" | "hidden";
                  workflow?: boolean;
                  write?: boolean;
                }
              | undefined)
          : undefined;

      return [
        field.id,
        {
          agent: explicit?.agent ?? definition.capabilities.supportsAgentMutation,
          fieldId: field.id,
          fieldType: field.field_type,
          read: explicit?.read ?? "visible",
          workflow: explicit?.workflow ?? behavior.allowsWorkflowTrigger,
          write: explicit?.write ?? behavior.allowsMutation
        }
      ] as const;
    })
  );

  return {
    fields,
    policyRevision,
    principalId: input.principalId,
    schemaEpoch: table.schema_epoch,
    scopeHash: buildPermissionScopeHash(input.scope),
    snapshotId: `resolved:${input.workspaceId}:${input.principalId}:${buildPermissionScopeHash(input.scope)}:${policyRevision}`,
    workspaceId: input.workspaceId
  };
}

async function readLatestPolicyRevision(
  db: D1Database,
  workspaceId: string,
  principalId: string,
  scope: PermissionResolutionScope
): Promise<number> {
  if (scope.kind === "workspace") {
    const snapshot = await db
      .prepare(
        `SELECT policy_revision, snapshot_json
         FROM permission_snapshots
         WHERE workspace_id = ? AND principal_id = ?
         ORDER BY policy_revision DESC
         LIMIT 1`
      )
      .bind(workspaceId, principalId)
      .first<PermissionSnapshotRow>();

    if (snapshot) {
      return snapshot.policy_revision;
    }
  }

  if (scope.kind !== "workspace") {
    const bindingRow = await db
      .prepare(
        `SELECT revision
         FROM permission_policy_bindings
         WHERE workspace_id = ?
           AND binding_key LIKE ?
         ORDER BY revision DESC
         LIMIT 1`
      )
      .bind(workspaceId, `field:${scope.tableId}:%:principal:${principalId}`)
      .first<PermissionPolicyRow>();

    if (bindingRow) {
      return bindingRow.revision;
    }

    const snapshotRow = await db
      .prepare(
        `SELECT policy_revision, snapshot_json
         FROM permission_snapshots
         WHERE workspace_id = ? AND principal_id = ?
           AND (scope_hash = ? OR scope_hash = ?)
         ORDER BY policy_revision DESC
         LIMIT 1`
      )
      .bind(
        workspaceId,
        principalId,
        `scope:table:${scope.tableId}`,
        scope.kind === "view" ? `scope:view:${scope.viewId}` : `scope:table:${scope.tableId}`
      )
      .first<PermissionSnapshotRow>();

    if (snapshotRow) {
      return snapshotRow.policy_revision;
    }
  }

  return 0;
}
