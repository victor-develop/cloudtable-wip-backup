import type { CommandEnvelope } from "../core/commands/types";
import { dispatchCommandToCoordinator, scopeForRoute } from "./durable-object-dispatch";
import { readRecordDetail } from "./direct-record-read";
import { createRuntime } from "./bootstrap";
import { badRequest, json, methodNotAllowed, notFound } from "./http";
import type { CloudTableEnv } from "./env";

export async function handleFetch(
  request: Request,
  env: CloudTableEnv,
  _ctx: ExecutionContext
): Promise<Response> {
  const runtime = createRuntime(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({
      ok: true,
      service: "cloudtable-platform",
      queues: [
        "event-fanout",
        "workflow-dispatch",
        "projection-maintenance",
        "dead-letter-reprocessor"
      ]
    });
  }

  if (request.method === "GET" && url.pathname === "/internal/scaffold") {
    return json({
      fieldTypes: runtime.fieldTypeRegistry.list(),
      workflowOperators: runtime.workflowOperatorRegistry.list(),
      agentTools: runtime.agentToolRegistry.list()
    });
  }

  const directRecordMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/records\/([^/]+)$/);
  if (directRecordMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return badRequest("workspaceId query parameter is required.");
    }

    const [, tableId, recordId] = directRecordMatch;
    const detail = await readRecordDetail(env.DB, workspaceId, tableId, recordId);

    if (!detail) {
      return notFound(`Record ${recordId} was not found in table ${tableId}.`);
    }

    return json({
      projection: detail.projection
        ? JSON.parse(detail.projection.projection_json)
        : null,
      projectionVersion: detail.projection?.projection_version ?? 0,
      record: {
        ...detail.record,
        lastEventId:
          detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
      }
    });
  }

  const routeScope = scopeForRoute(url.pathname);
  if (routeScope) {
    if (!["POST", "PATCH"].includes(request.method)) {
      return methodNotAllowed(request.method, ["POST", "PATCH"]);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return badRequest("Command body must be valid JSON.");
    }

    const command = {
      ...(body as Partial<CommandEnvelope>),
      scope: routeScope.scope,
      tableId: routeScope.tableId ?? (body.tableId as string | undefined),
      workspaceId: body.workspaceId as string | undefined
    } satisfies Partial<CommandEnvelope>;

    if (typeof command.workspaceId !== "string" || command.workspaceId.length === 0) {
      return badRequest("workspaceId is required in the command body.");
    }

    if (routeScope.scope === "table" && typeof command.tableId !== "string") {
      return badRequest("tableId could not be resolved for this table route.");
    }

    if (
      request.method === "PATCH" &&
      directRecordMatch === null &&
      routeScope.scope === "table" &&
      url.pathname.includes("/records/")
    ) {
      const recordId = url.pathname.split("/").at(-1);
      command.payload = {
        ...((body.payload as Record<string, unknown> | undefined) ?? {}),
        recordId
      };
    }

    return dispatchCommandToCoordinator(
      env,
      url.origin,
      command as CommandEnvelope
    );
  }

  return notFound("CloudTable route not found.");
}
