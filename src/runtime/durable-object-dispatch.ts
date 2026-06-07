import type { CommandEnvelope, CommandScope } from "../core/commands/types";
import type { CloudTableEnv } from "./env";

export type CommandRouteMatch = {
  commandType: string;
  params: Record<string, string>;
  scope: CommandScope;
  tableId?: string;
};

type DispatchTarget = {
  namespace: DurableObjectNamespace;
  objectName: string;
  pathname: string;
};

export function matchCommandRoute(
  pathname: string,
  method = "POST"
): CommandRouteMatch | null {
  if (pathname === "/v1/apps" || pathname === "/v1/bases") {
    return {
      commandType: "base.create",
      params: {},
      scope: "workspace"
    };
  }

  if (pathname === "/v1/tables") {
    return {
      commandType: "table.create",
      params: {},
      scope: "workspace"
    };
  }

  const baseTableMatch = pathname.match(/^\/v1\/bases\/([^/]+)\/tables$/);
  if (baseTableMatch) {
    return {
      commandType: "table.create",
      params: {
        baseId: baseTableMatch[1]
      },
      scope: "workspace"
    };
  }

  const fieldMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/fields$/);
  if (fieldMatch) {
    return {
      commandType: "field.create",
      params: {
        tableId: fieldMatch[1]
      },
      scope: "workspace",
      tableId: fieldMatch[1]
    };
  }

  const fieldUpdateMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/fields\/([^/]+)$/);
  if (fieldUpdateMatch && (method === "PATCH" || method === "PUT")) {
    return {
      commandType: "field.update",
      params: {
        fieldId: fieldUpdateMatch[2],
        tableId: fieldUpdateMatch[1]
      },
      scope: "workspace",
      tableId: fieldUpdateMatch[1]
    };
  }

  const fieldPermissionMatch = pathname.match(
    /^\/v1\/tables\/([^/]+)\/fields\/([^/]+)\/permissions\/([^/]+)$/
  );
  if (fieldPermissionMatch && (method === "PUT" || method === "PATCH")) {
    return {
      commandType: "field.permission.configure",
      params: {
        fieldId: fieldPermissionMatch[2],
        principalId: fieldPermissionMatch[3],
        tableId: fieldPermissionMatch[1]
      },
      scope: "workspace",
      tableId: fieldPermissionMatch[1]
    };
  }

  const recordCollectionMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/records$/);
  if (recordCollectionMatch) {
    return {
      commandType: "record.create",
      params: {
        tableId: recordCollectionMatch[1]
      },
      scope: "table",
      tableId: recordCollectionMatch[1]
    };
  }

  const recordMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/records\/([^/]+)$/);
  if (recordMatch && (method === "PATCH" || method === "PUT" || method === "DELETE")) {
    return {
      commandType: method === "DELETE" ? "record.archive" : "record.update",
      params: {
        recordId: recordMatch[2],
        tableId: recordMatch[1]
      },
      scope: "table",
      tableId: recordMatch[1]
    };
  }

  const viewCollectionMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/views$/);
  if (viewCollectionMatch) {
    return {
      commandType: "view.create",
      params: {
        tableId: viewCollectionMatch[1]
      },
      scope: "workspace",
      tableId: viewCollectionMatch[1]
    };
  }

  const viewMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/views\/([^/]+)$/);
  if (viewMatch && (method === "PATCH" || method === "PUT")) {
    return {
      commandType: "view.update",
      params: {
        tableId: viewMatch[1],
        viewId: viewMatch[2]
      },
      scope: "workspace",
      tableId: viewMatch[1]
    };
  }

  if (pathname === "/v1/workflows") {
    return {
      commandType: "workflow.create",
      params: {},
      scope: "workflow"
    };
  }

  const tableWorkflowMatch = pathname.match(/^\/v1\/tables\/([^/]+)\/workflows$/);
  if (tableWorkflowMatch) {
    return {
      commandType: "workflow.create",
      params: {
        tableId: tableWorkflowMatch[1]
      },
      scope: "workflow",
      tableId: tableWorkflowMatch[1]
    };
  }

  const workflowPublishMatch = pathname.match(/^\/v1\/workflows\/([^/]+)\/publish$/);
  if (workflowPublishMatch && (method === "POST" || method === "PUT")) {
    return {
      commandType: "workflow.publish",
      params: {
        workflowId: workflowPublishMatch[1]
      },
      scope: "workflow"
    };
  }

  const workflowPauseMatch = pathname.match(/^\/v1\/workflows\/([^/]+)\/pause$/);
  if (workflowPauseMatch && (method === "POST" || method === "PUT")) {
    return {
      commandType: "workflow.pause",
      params: {
        workflowId: workflowPauseMatch[1]
      },
      scope: "workflow"
    };
  }

  const workflowExecuteMatch = pathname.match(/^\/v1\/workflows\/([^/]+)\/execute$/);
  if (workflowExecuteMatch && (method === "POST" || method === "PUT")) {
    return {
      commandType: "workflow.manual",
      params: {
        workflowId: workflowExecuteMatch[1]
      },
      scope: "workflow"
    };
  }

  const cellMatch = pathname.match(
    /^\/v1\/tables\/([^/]+)\/records\/([^/]+)\/cells\/([^/]+)$/
  );
  if (cellMatch) {
    return {
      commandType: "cell.set",
      params: {
        fieldId: cellMatch[3],
        recordId: cellMatch[2],
        tableId: cellMatch[1]
      },
      scope: "table",
      tableId: cellMatch[1]
    };
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
