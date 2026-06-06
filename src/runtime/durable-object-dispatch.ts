import type { CommandEnvelope, CommandScope } from "../core/commands/types";
import type { CloudTableEnv } from "./env";

type DispatchTarget = {
  namespace: DurableObjectNamespace;
  objectName: string;
  pathname: string;
};

export function scopeForRoute(
  pathname: string
): { scope: CommandScope; tableId?: string } | null {
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== "v1") {
    return null;
  }

  if (
    pathname === "/v1/workspaces" ||
    pathname === "/v1/apps" ||
    pathname === "/v1/tables" ||
    pathname === "/v1/views" ||
    pathname === "/v1/workflows"
  ) {
    return { scope: "workspace" };
  }

  if (segments[1] !== "tables") {
    return null;
  }

  const tableId = segments[2];
  if (!tableId) {
    return null;
  }

  const suffix = segments.slice(3);
  const fieldRoute =
    suffix[0] === "fields" && (suffix.length === 1 || suffix.length === 2);
  const recordRoute =
    suffix[0] === "records" &&
    (suffix.length === 1 ||
      suffix.length === 2 ||
      (suffix.length === 1 && pathname.endsWith(":bulkPatch")));

  if (fieldRoute) {
    return { scope: "workspace", tableId };
  }

  if (recordRoute || pathname === `/v1/tables/${tableId}/records:bulkPatch`) {
    return { scope: "table", tableId };
  }

  return null;
}

export function resolveDurableObjectTarget(
  env: CloudTableEnv,
  command: CommandEnvelope
): DispatchTarget {
  if (command.scope === "table") {
    if (!command.tableId) {
      throw new Error("tableId is required for table-scoped commands.");
    }

    return {
      namespace: env.TABLE_COORDINATOR_DO,
      objectName: `${command.workspaceId}:${command.tableId}`,
      pathname: "/commands"
    };
  }

  return {
    namespace: env.WORKSPACE_CONTROL_DO,
    objectName: command.workspaceId,
    pathname: "/commands"
  };
}

export async function dispatchCommandToCoordinator(
  env: CloudTableEnv,
  origin: string,
  command: CommandEnvelope
): Promise<Response> {
  const target = resolveDurableObjectTarget(env, command);
  const id = target.namespace.idFromName(target.objectName);
  const stub = target.namespace.get(id);

  return stub.fetch(
    new Request(new URL(target.pathname, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(command)
    })
  );
}
