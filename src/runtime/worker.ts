import type {
  ConfigureFieldPermissionToolInput,
  CreateFieldToolInput,
  CreateTableToolInput,
  CreateViewToolInput,
  DryRunCommandToolInput,
  ExecuteCommandToolInput,
  AgentToolId,
  AgentToolInvocation,
  AgentToolInvocationResult,
  InspectWorkspaceToolInput,
  ProposeWorkflowToolInput,
  UpdateViewToolInput
} from "../core/agent-tools/types";
import type { CommandEnvelope, CommandResult } from "../core/commands/types";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import type { PermissionProjectionInput } from "../core/permissions/types";
import { aggregateDescriptorForCommand } from "../core/commands/domain";
import {
  dispatchCommandToCoordinator,
  matchCommandRoute
} from "./durable-object-dispatch";
import { readRecordDetail, readRecordFields } from "./direct-record-read";
import { resolvePermissionSnapshot } from "./permission-snapshot";
import {
  readTableSchemaMetadata,
  readViewDefinitionMetadata
} from "./schema-metadata-read";
import { readViewQuery } from "./view-query-read";
import {
  readWorkflowHistoryForRun,
  readWorkflowHistoryForWorkflow,
  readWorkflowIdForDeadLetter,
  readWorkflowIdForRun,
  readWorkflowTriggerTableIdForWorkflow,
  requestWorkflowDeadLetterReplay,
  workflowOperationsAuthorized
} from "./workflow-operations";
import { createRuntime, createRuntimeWithSnapshot } from "./bootstrap";
import { badRequest, conflict, forbidden, json, methodNotAllowed, notFound } from "./http";
import type { CloudTableEnv } from "./env";
import {
  readWorkflowDefinitionMetadata,
  readWorkflowExecutionCandidate,
  readWorkflowTriggerTableId
} from "./workflow-definition";
import { createWorkspaceInspector } from "./workspace-inspector";
import type { WorkflowOperatorDefinition } from "../core/workflows/types";

type CommandPermissionScope =
  | {
      kind: "workspace";
    }
  | {
      kind: "table";
      tableId: string;
    };

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
        "workflow-step",
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

  const workspaceCatalogMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/catalog$/);
  if (workspaceCatalogMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = workspaceCatalogMatch[1]!;
    const auth = await resolveWorkspaceCatalogAccess(env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    const include = readWorkspaceInspectionInclude(url.searchParams);
    if ("response" in include) {
      return include.response;
    }

    const workspaceInspector = createWorkspaceInspector(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.workflowOperatorRegistry
    );

    return json(
      await workspaceInspector.inspect({
        ...(include.sections ? { include: include.sections } : {}),
        workspaceId
      })
    );
  }

  const workflowOperatorCatalogMatch = url.pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/workflow-operators$/
  );
  if (workflowOperatorCatalogMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = workflowOperatorCatalogMatch[1]!;
    const auth = await resolveWorkspaceCatalogAccess(env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    return json({
      workspaceId,
      workflowOperators: runtime.workflowOperatorRegistry
        .list()
        .map(serializeWorkflowOperatorManifest)
    });
  }

  const tableSchemaMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/schema$/);
  if (tableSchemaMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return badRequest("workspaceId query parameter is required.");
    }

    const tableId = tableSchemaMatch[1]!;
    const auth = await resolveSchemaMetadataAccess(env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      scope: {
        kind: "table",
        tableId
      },
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    const detail = await readTableSchemaMetadata(env.DB, {
      tableId,
      workspaceId
    });
    if (!detail) {
      return notFound(`Table ${tableId} was not found.`);
    }

    const hiddenFieldIds = detail.fields
      .filter(
        (field) =>
          runtime.permissionEngine.evaluateFieldAccess(
            {
              fieldConfig: field.config,
              fieldId: field.fieldId,
              fieldType: field.fieldType
            },
            "direct-record-read",
            auth.snapshot
          ).readState === "hidden"
      )
      .map((field) => field.fieldId);
    if (hiddenFieldIds.length > 0) {
      return forbidden(
        `Principal ${auth.principalId} is not allowed to inspect table schema metadata for ${tableId}.`,
        {
          hiddenFieldIds
        }
      );
    }

    return json(detail);
  }

  const viewDefinitionMatch = url.pathname.match(
    /^\/v1\/tables\/([^/]+)\/views\/([^/]+)\/definition$/
  );
  if (viewDefinitionMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return badRequest("workspaceId query parameter is required.");
    }

    const tableId = viewDefinitionMatch[1]!;
    const viewId = viewDefinitionMatch[2]!;
    const auth = await resolveSchemaMetadataAccess(env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      scope: {
        kind: "view",
        tableId,
        viewId
      },
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    const detail = await readViewDefinitionMetadata(env.DB, {
      tableId,
      viewId,
      workspaceId
    });
    if (!detail) {
      return notFound(`View ${viewId} was not found in table ${tableId}.`);
    }

    const referencedFieldIds = Array.from(
      new Set([
        ...detail.definition.visibleFieldIds,
        ...detail.definition.sortFieldIds,
        ...(detail.definition.groupByFieldId ? [detail.definition.groupByFieldId] : [])
      ])
    );
    const hiddenFieldIds = referencedFieldIds.filter((fieldId) => {
      const field = auth.snapshot.fields[fieldId];
      if (!field) {
        return false;
      }

      return (
        runtime.permissionEngine.evaluateFieldAccess(field, "view-query", auth.snapshot).readState ===
        "hidden"
      );
    });
    if (hiddenFieldIds.length > 0) {
      return forbidden(
        `Principal ${auth.principalId} is not allowed to inspect saved view definition metadata for ${viewId}.`,
        {
          hiddenFieldIds
        }
      );
    }

    const protectedFilterFieldIds = new Set(
      detail.definition.filters
        .map((filter) => filter.fieldId)
        .filter((fieldId) => auth.snapshot.fields[fieldId]?.read !== "visible")
    );

    return json({
      ...detail,
      definition: {
        ...detail.definition,
        filters: detail.definition.filters.map((filter) =>
          protectedFilterFieldIds.has(filter.fieldId)
            ? {
                comparator: filter.comparator,
                fieldId: filter.fieldId,
                operatorId: filter.operatorId,
                protected: true
              }
            : {
                ...filter,
                protected: false
              }
        )
      }
    });
  }

  if (url.pathname === "/v1/agent-tools/preview") {
    return handleAgentToolIngress(request, env, "preview");
  }

  if (url.pathname === "/v1/agent-tools/execute") {
    return handleAgentToolIngress(request, env, "execute");
  }

  if (url.pathname === "/v1/commands/preview") {
    return handleCommandPreviewIngress(request, env);
  }

  if (url.pathname === "/v1/commands/execute") {
    return handleCommandExecuteIngress(request, env);
  }

  const workflowDefinitionMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/definition$/);
  if (workflowDefinitionMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const auth = await resolveWorkflowOperationsAccess(env, {
      principalId: url.searchParams.get("principalId"),
      workflowId: workflowDefinitionMatch[1] ?? null,
      workspaceId: url.searchParams.get("workspaceId"),
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision")
    });
    if ("response" in auth) {
      return auth.response;
    }

    const detail = await readWorkflowDefinitionMetadata(env.DB, auth.workspaceId, auth.workflowId);
    if (!detail) {
      return notFound(`Workflow ${auth.workflowId} was not found.`);
    }

    const protectedFieldIds = detail.referencedFieldIds.filter((fieldId) => {
      const field = auth.snapshot.fields[fieldId];
      if (!field) {
        return true;
      }

      return (
        runtime.permissionEngine.evaluateFieldAccess(field, "view-query", auth.snapshot).readState ===
        "hidden"
      );
    });
    if (protectedFieldIds.length > 0) {
      return forbidden(
        `Principal ${auth.principalId} is not allowed to inspect workflow definition metadata for ${auth.workflowId}.`,
        {
          protectedFieldIds
        }
      );
    }

    const { referencedFieldIds: _referencedFieldIds, ...response } = detail;
    return json(response);
  }

  const workflowHistoryMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/history$/);
  if (workflowHistoryMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const auth = await resolveWorkflowOperationsAccess(env, {
      principalId: url.searchParams.get("principalId"),
      workflowId: workflowHistoryMatch[1] ?? null,
      workspaceId: url.searchParams.get("workspaceId"),
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision")
    });
    if ("response" in auth) {
      return auth.response;
    }

    return json(await readWorkflowHistoryForWorkflow(env.DB, auth.workspaceId, auth.workflowId));
  }

  const workflowRunHistoryMatch = url.pathname.match(/^\/v1\/workflow-runs\/([^/]+)$/);
  if (workflowRunHistoryMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const auth = await resolveWorkflowOperationsAccess(env, {
      principalId: url.searchParams.get("principalId"),
      workflowRunId: workflowRunHistoryMatch[1] ?? null,
      workspaceId: url.searchParams.get("workspaceId"),
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision")
    });
    if ("response" in auth) {
      return auth.response;
    }

    const workflowRunId = workflowRunHistoryMatch[1]!;
    const history = await readWorkflowHistoryForRun(env.DB, auth.workspaceId, workflowRunId);
    if (!history) {
      return notFound(`Workflow run ${workflowRunId} was not found.`);
    }

    return json(history);
  }

  const workflowDeadLetterReplayMatch = url.pathname.match(
    /^\/v1\/workflow-dead-letters\/([^/]+)\/replay$/
  );
  if (workflowDeadLetterReplayMatch) {
    if (request.method !== "POST") {
      return methodNotAllowed(request.method, ["POST"]);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return badRequest("Workflow dead-letter replay body must be valid JSON.");
    }

    const auth = await resolveWorkflowOperationsAccess(env, {
      deadLetterId: workflowDeadLetterReplayMatch[1] ?? null,
      principalId: readNonEmptyString(body.principalId),
      workflowId: null,
      workspaceId: readNonEmptyString(body.workspaceId),
      permissionScopeHash: readNonEmptyString(body.permissionScopeHash),
      policyRevisionValue:
        typeof body.policyRevision === "number" ? String(body.policyRevision) : null
    });
    if ("response" in auth) {
      return auth.response;
    }

    const replayRequestId =
      readNonEmptyString(body.replayRequestId) ??
      readNonEmptyString(body.idempotencyKey) ??
      `dead-letter-replay:${workflowDeadLetterReplayMatch[1]!}`;
    const replay = await requestWorkflowDeadLetterReplay(env, {
      deadLetterId: workflowDeadLetterReplayMatch[1]!,
      principalId: auth.principalId,
      replayRequestId
    });

    if (!replay.ok) {
      if (replay.reason === "not_found") {
        return notFound(replay.message);
      }
      if (replay.reason === "already_requested") {
        return conflict(replay.message);
      }
      return badRequest(replay.message);
    }

    return json(
      {
        deadLetterId: workflowDeadLetterReplayMatch[1]!,
        status: replay.status
      },
      { status: 202 }
    );
  }

  const directRecordMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/records\/([^/]+)$/);
  if (directRecordMatch && request.method === "GET") {

    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return badRequest("workspaceId query parameter is required.");
    }
    const principalId = url.searchParams.get("principalId");
    const policyRevisionValue = url.searchParams.get("policyRevision");
    const policyRevision =
      typeof policyRevisionValue === "string" && policyRevisionValue.length > 0
        ? Number(policyRevisionValue)
        : null;
    const permissionScopeHash = url.searchParams.get("permissionScopeHash");

    if (!principalId && (policyRevisionValue !== null || permissionScopeHash !== null)) {
      return badRequest(
        "principalId query parameter is required when permission coordinates are provided for direct record reads."
      );
    }

    if (policyRevisionValue !== null && (typeof policyRevision !== "number" || Number.isNaN(policyRevision))) {
      return badRequest("policyRevision must be a finite number when provided for permissioned direct record reads.");
    }

    const [, tableId, recordId] = directRecordMatch;
    const detail = await readRecordDetail(env.DB, workspaceId, tableId, recordId);

    if (!detail) {
      return notFound(`Record ${recordId} was not found in table ${tableId}.`);
    }

    const rawProjection = detail.projection
      ? (JSON.parse(detail.projection.projection_json) as {
          fields?: Record<string, unknown>;
        })
      : null;
    let snapshot: EffectivePermissionSnapshot | undefined;
    if (principalId) {
      const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
        fieldTypeRegistry: runtime.fieldTypeRegistry,
        permissionScopeHash,
        policyRevision,
        principalId,
        scope: {
          kind: "table",
          tableId
        },
        workspaceId
      });

      if (!resolvedSnapshot.ok) {
        return badRequest(resolvedSnapshot.message);
      }

      snapshot = resolvedSnapshot.snapshot;
    }

    if (principalId && snapshot && rawProjection) {
      const recordFields = await readRecordFields(env.DB, workspaceId, tableId);
      const projectionInputs: PermissionProjectionInput[] = recordFields.map((field) => ({
        fieldId: field.id,
        fieldType: field.field_type,
        value: rawProjection.fields?.[field.field_key] ?? null
      }));
      const projected = runtime.permissionEngine.projectFields(
        projectionInputs,
        "direct-record-read",
        snapshot
      );
      const permissionedFields = Object.fromEntries(
        recordFields.flatMap((field) =>
          Object.prototype.hasOwnProperty.call(projected.fields, field.id)
            ? [[field.field_key, projected.fields[field.id]]]
            : []
        )
      );

      return json({
        projection: {
          fields: permissionedFields
        },
        projectionVersion: detail.projection?.projection_version ?? 0,
        record: {
          ...detail.record,
          lastEventId:
            detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
        },
        surface: {
          diagnostics: projected.diagnostics,
          hiddenFieldIds: projected.hiddenFieldIds,
          redactedFieldIds: projected.redactedFieldIds,
          redactionApplied: projected.redactedFieldIds.length > 0,
          states: projected.states
        }
      });
    }

    return json({
      projection: rawProjection,
      projectionVersion: detail.projection?.projection_version ?? 0,
      record: {
        ...detail.record,
        lastEventId:
          detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
      }
    });
  }

  const viewReadMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/views\/([^/]+)$/);
  if (viewReadMatch && request.method === "GET") {
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return badRequest("workspaceId query parameter is required.");
    }

    const principalId = url.searchParams.get("principalId");
    const policyRevisionValue = url.searchParams.get("policyRevision");
    const policyRevision =
      typeof policyRevisionValue === "string" && policyRevisionValue.length > 0
        ? Number(policyRevisionValue)
        : null;
    const permissionScopeHash = url.searchParams.get("permissionScopeHash");

    if (!principalId && (policyRevisionValue !== null || permissionScopeHash !== null)) {
      return badRequest(
        "principalId query parameter is required when permission coordinates are provided for view reads."
      );
    }

    if (policyRevisionValue !== null && (typeof policyRevision !== "number" || Number.isNaN(policyRevision))) {
      return badRequest("policyRevision must be a finite number when provided for permissioned view reads.");
    }

    const [, tableId, viewId] = viewReadMatch;
    let resolvedSnapshot: Awaited<ReturnType<typeof resolvePermissionSnapshot>> | null = null;
    if (principalId) {
      resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
        fieldTypeRegistry: runtime.fieldTypeRegistry,
        permissionScopeHash,
        policyRevision,
        principalId,
        scope: {
          kind: "view",
          tableId,
          viewId
        },
        workspaceId
      });

      if (!resolvedSnapshot.ok) {
        return badRequest(resolvedSnapshot.message);
      }
    }

    const detail = await readViewQuery(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        permissionScopeHash: resolvedSnapshot?.ok ? resolvedSnapshot.snapshot.scopeHash : null,
        policyRevision: resolvedSnapshot?.ok ? resolvedSnapshot.snapshot.policyRevision : null,
        principalId: resolvedSnapshot?.ok ? resolvedSnapshot.snapshot.principalId : null,
        snapshot: resolvedSnapshot?.ok ? resolvedSnapshot.snapshot : undefined,
        tableId,
        viewId,
        workspaceId
      }
    );

    if (!detail) {
      return notFound(`View ${viewId} was not found in table ${tableId}.`);
    }

    return json(detail);
  }

  const route = matchCommandRoute(url.pathname, request.method);
  if (route) {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
      return methodNotAllowed(request.method, ["POST", "PATCH", "PUT", "DELETE"]);
    }

    const normalized = await normalizeCommandIngress(
      env,
      runtime,
      request,
      buildCommandIngressCandidateFromRoute(request.method, await readCommandIngressBody(request), route)
    );
    if ("response" in normalized) {
      return normalized.response;
    }

    const response = await dispatchCommandToCoordinator(
      env,
      url.origin,
      normalized.command
    );

    const responseBody = (await response.json()) as Record<string, unknown>;
    return json({
      ...responseBody,
      aggregate: aggregateDescriptorForCommand(normalized.command)
    });
  }

  return notFound("CloudTable route not found.");
}

async function handleCommandPreviewIngress(
  request: Request,
  env: CloudTableEnv
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(request.method, ["POST"]);
  }

  const runtime = createRuntime(env);
  const normalized = await normalizeCommandIngress(
    env,
    runtime,
    request,
    await readCommandIngressBody(request)
  );
  if ("response" in normalized) {
    return normalized.response;
  }

  return json({
    aggregate: aggregateDescriptorForCommand(normalized.command),
    command: normalized.command,
    result: await runtime.commandBus.dryRun(normalized.command)
  });
}

async function handleCommandExecuteIngress(
  request: Request,
  env: CloudTableEnv
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(request.method, ["POST"]);
  }

  const runtime = createRuntime(env);
  const normalized = await normalizeCommandIngress(
    env,
    runtime,
    request,
    await readCommandIngressBody(request)
  );
  if ("response" in normalized) {
    return normalized.response;
  }

  const response = await dispatchCommandToCoordinator(env, new URL(request.url).origin, normalized.command);
  const responseBody = (await response.json()) as Record<string, unknown>;

  return json({
    ...responseBody,
    aggregate: aggregateDescriptorForCommand(normalized.command),
    command: normalized.command
  });
}

async function readCommandIngressBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const rawBody = await request.text();
    return rawBody.trim().length === 0
      ? {}
      : ((JSON.parse(rawBody) as Record<string, unknown>) ?? {});
  } catch {
    return badRequest("Command body must be valid JSON.");
  }
}

function buildCommandIngressCandidateFromRoute(
  method: string,
  bodyOrResponse: Record<string, unknown> | Response,
  route: ReturnType<typeof matchCommandRoute>
): Partial<CommandEnvelope> | Response {
  if (bodyOrResponse instanceof Response) {
    return bodyOrResponse;
  }

  return {
    ...(bodyOrResponse as Partial<CommandEnvelope>),
    commandType: (bodyOrResponse.commandType as string | undefined) ?? route?.commandType,
    payload: {
      ...(((bodyOrResponse.payload as Record<string, unknown> | undefined) ?? {}) as Record<
        string,
        unknown
      >),
      ...(route?.params ?? {})
    },
    scope: route?.scope,
    tableId: route?.tableId ?? (bodyOrResponse.tableId as string | undefined),
    workspaceId: bodyOrResponse.workspaceId as string | undefined
  } satisfies Partial<CommandEnvelope>;
}

async function normalizeCommandIngress(
  env: CloudTableEnv,
  runtime: ReturnType<typeof createRuntime>,
  request: Request,
  candidateOrResponse: Partial<CommandEnvelope> | Response
): Promise<{ command: CommandEnvelope } | { response: Response }> {
  if (candidateOrResponse instanceof Response) {
    return {
      response: candidateOrResponse
    };
  }

  const command = candidateOrResponse;

  if (typeof command.workspaceId !== "string" || command.workspaceId.length === 0) {
    return {
      response: badRequest("workspaceId is required in the command body.")
    };
  }

  if (command.scope === "table" && typeof command.tableId !== "string") {
    return {
      response: badRequest("tableId could not be resolved for this table route.")
    };
  }

  if (
    typeof command.permissionsVersion !== "undefined" &&
    (typeof command.permissionsVersion !== "number" || Number.isNaN(command.permissionsVersion))
  ) {
    return {
      response: badRequest(
        "permissionsVersion must be a finite number when provided for command ingress."
      )
    };
  }

  if (
    typeof command.permissionScopeHash !== "undefined" &&
    typeof command.permissionScopeHash !== "string"
  ) {
    return {
      response: badRequest("permissionScopeHash must be a string when provided for command ingress.")
    };
  }

  const actorPrincipalId = readNonEmptyString(command.actor?.principalId);
  const actorMode = command.actor?.mode;
  if (!actorPrincipalId || (actorMode !== "user" && actorMode !== "workflow" && actorMode !== "agent")) {
    return {
      response: badRequest("actor.principalId and actor.mode are required for command ingress.")
    };
  }

  const resolvedPermissionScope = await resolveCommandPermissionScope(env.DB, command);
  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    permissionScopeHash:
      typeof command.permissionScopeHash === "string" ? command.permissionScopeHash : undefined,
    policyRevision:
      typeof command.permissionsVersion === "number" ? command.permissionsVersion : undefined,
    principalId: actorPrincipalId,
    scope: resolvedPermissionScope,
    workspaceId: command.workspaceId
  });

  if (!resolvedSnapshot.ok) {
    return {
      response: badRequest(resolvedSnapshot.message)
    };
  }

  const manualInvocationId =
    command.commandType === "workflow.manual"
      ? readNonEmptyString(command.payload?.manualInvocationId) ??
        readNonEmptyString(command.idempotencyKey)
      : null;

  const normalizedCommand: CommandEnvelope = {
    ...(command as CommandEnvelope),
    actor: {
      mode: actorMode,
      principalId: actorPrincipalId
    },
    payload:
      command.commandType === "workflow.manual"
        ? {
            ...((command.payload ?? {}) as Record<string, unknown>),
            input:
              isRecord(command.payload) && isRecord(command.payload.input)
                ? command.payload.input
                : {},
            manualInvocationId
          }
        : (command.payload as Record<string, unknown>),
    permissionScopeHash: resolvedSnapshot.snapshot.scopeHash,
    permissionsVersion: resolvedSnapshot.snapshot.policyRevision
  };

  if (normalizedCommand.commandType === "workflow.manual") {
    const workflowId = readNonEmptyString(normalizedCommand.payload.workflowId);
    if (!workflowId) {
      return {
        response: badRequest("workflowId is required for manual workflow execution.")
      };
    }

    const candidate = await readWorkflowExecutionCandidate(
      env.DB,
      normalizedCommand.workspaceId,
      workflowId
    );
    if (!candidate.ok) {
      return {
        response: badRequest(candidate.reason)
      };
    }
  }

  return {
    command: normalizedCommand
  };
}

function buildAgentToolInvocation(
  toolId: AgentToolId,
  input: Record<string, unknown>,
  ingress: "preview" | "execute",
  context: {
    permissionScopeHash: string;
    policyRevision: number;
    principalId: string;
    snapshot: EffectivePermissionSnapshot;
    workspaceId: string;
  }
): AgentToolInvocation {
  const commandContext = {
    actor: {
      mode: "agent" as const,
      principalId: context.principalId
    },
    permissionScopeHash: context.permissionScopeHash,
    permissionsVersion: context.policyRevision,
    schemaEpoch:
      typeof input.schemaEpoch === "number" ? input.schemaEpoch : context.snapshot.schemaEpoch,
    workspaceId: context.workspaceId
  };

  switch (toolId) {
    case "inspectWorkspace":
      return {
        input: {
          ...input,
          workspaceId: context.workspaceId
        } as InspectWorkspaceToolInput,
        toolId
      };
    case "createTable":
      return {
        input: {
          ...input,
          ...commandContext
        } as CreateTableToolInput,
        toolId
      };
    case "createField":
      return {
        input: {
          ...input,
          ...commandContext
        } as CreateFieldToolInput,
        toolId
      };
    case "createView":
      return {
        input: {
          ...input,
          ...commandContext
        } as CreateViewToolInput,
        toolId
      };
    case "updateView":
      return {
        input: {
          ...input,
          ...commandContext
        } as UpdateViewToolInput,
        toolId
      };
    case "configureFieldPermission":
      return {
        input: {
          ...input,
          ...commandContext
        } as ConfigureFieldPermissionToolInput,
        toolId
      };
    case "proposeWorkflow":
      return {
        input: {
          ...input,
          ...commandContext
        } as ProposeWorkflowToolInput,
        toolId
      };
    case "dryRunCommand":
      return {
        input: {
          command: normalizeAgentCommand(input.command, commandContext)
        } as DryRunCommandToolInput,
        toolId
      };
    case "executeCommand":
      if (ingress !== "execute") {
        throw new Error("Execution-phase agent tools are not allowed on the preview ingress.");
      }
      return {
        input: {
          command: normalizeAgentCommand(input.command, commandContext)
        } as ExecuteCommandToolInput,
        toolId
      };
  }
}

async function handleAgentToolIngress(
  request: Request,
  env: CloudTableEnv,
  ingress: "preview" | "execute"
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(request.method, ["POST"]);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest(`Agent tool ${ingress} body must be valid JSON.`);
  }

  const workspaceId = readNonEmptyString(body.workspaceId);
  const principalId = readNonEmptyString(body.principalId);
  const permissionScopeHash = readNonEmptyString(body.permissionScopeHash);
  const toolId = readNonEmptyString(body.toolId);
  const input = isRecord(body.input) ? body.input : null;
  const policyRevision =
    typeof body.policyRevision === "number" && Number.isFinite(body.policyRevision)
      ? body.policyRevision
      : null;

  if (!workspaceId || !principalId || !toolId || !input) {
    return badRequest(
      `workspaceId, principalId, toolId, and object input are required for agent tool ${ingress}.`
    );
  }

  if (body.policyRevision !== undefined && policyRevision === null) {
    return badRequest(`policyRevision must be a finite number when provided for agent tool ${ingress}.`);
  }

  const runtime = createRuntime(env);
  const resolvedScope = resolveAgentToolScope(toolId as AgentToolId, workspaceId, input);
  if (!resolvedScope.ok) {
    return badRequest(resolvedScope.message);
  }

  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    permissionScopeHash,
    policyRevision,
    principalId,
    scope: resolvedScope.scope,
    workspaceId
  });

  if (!resolvedSnapshot.ok) {
    return badRequest(resolvedSnapshot.message);
  }

  const snapshot = resolvedSnapshot.snapshot;
  const permissionedRuntime = createRuntimeWithSnapshot(env, snapshot);
  let tool;
  try {
    tool = permissionedRuntime.agentToolRegistry.require(toolId as AgentToolId);
  } catch {
    return badRequest(`Unknown agent tool: ${toolId}`);
  }

  if (ingress === "preview" && tool.phase === "execute") {
    return badRequest("Execution-phase agent tools are not exposed on the preview ingress.");
  }

  if (ingress === "execute" && tool.phase !== "execute") {
    return badRequest("Only execution-phase agent tools are exposed on the execution ingress.");
  }

  const fields = Object.values(snapshot.fields).map((field) => ({
    fieldId: field.fieldId,
    fieldType: field.fieldType
  }));
  const access = permissionedRuntime.agentToolRegistry
    .listAccessible(fields, snapshot)
    .find((candidate) => candidate.toolId === tool.id) ?? {
    allowed: true,
    hiddenFieldIds: [],
    reason: null,
    toolId: tool.id,
    visibleFieldIds: []
  };

  if (!access.allowed) {
    return badRequest(access.reason ?? `Agent tool is not allowed on the ${ingress} ingress.`);
  }

  const sanitizedInput = permissionedRuntime.agentToolRegistry.sanitizeInput(
    tool.id,
    input,
    fields,
    snapshot
  );

  let invocation: AgentToolInvocation;
  try {
    invocation = buildAgentToolInvocation(tool.id, sanitizedInput.sanitized, ingress, {
      permissionScopeHash: snapshot.scopeHash,
      policyRevision: snapshot.policyRevision,
      principalId,
      snapshot,
      workspaceId
    });
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : `Agent tool ${ingress} input was invalid.`
    );
  }

  const result =
    invocation.toolId === "executeCommand"
      ? await invokeReviewedExecutionTool(invocation.input.command, env, request.url)
      : await permissionedRuntime.agentToolRegistry.invoke(invocation);
  const serializedResult = serializeAgentToolResult(result);
  const sanitizedOutput = permissionedRuntime.agentToolRegistry.sanitizeOutput(
    tool.id,
    serializedResult,
    fields,
    snapshot
  );

  return json({
    access,
    input: sanitizedInput.sanitized,
    inputDiagnostics: sanitizedInput.diagnostics,
    output: sanitizedOutput.sanitized,
    outputDiagnostics: sanitizedOutput.diagnostics,
    permissionScope: {
      policyRevision: snapshot.policyRevision,
      principalId: snapshot.principalId,
      scopeHash: snapshot.scopeHash,
      workspaceId
    },
    tool: {
      id: tool.id,
      phase: tool.phase,
      scope: tool.scope,
      successorToolId: tool.successorToolId ?? null
    }
  });
}

async function invokeReviewedExecutionTool(
  command: CommandEnvelope,
  env: CloudTableEnv,
  requestUrl: string
): Promise<AgentToolInvocationResult> {
  const response = await dispatchCommandToCoordinator(env, new URL(requestUrl).origin, command);
  const responseBody = (await response.json()) as {
    result?: CommandResult;
  };

  return {
    command,
    kind: "command-execution",
    result: responseBody.result ?? {
      accepted: false,
      diagnostics: ["agent_tool_execution_missing_result"],
      events: [],
      permission: {
        allowed: false,
        reasons: ["agent_tool_execution_missing_result"]
      },
      replayProjection: {
        acceptedCommandIds: [],
        lastLogicalTime: new Date(0).toISOString(),
        receiptCount: 0,
        receipts: []
      },
      sideEffects: [],
      status: "rejected"
    }
  };
}

function normalizeAgentCommand(
  value: unknown,
  context: {
    actor: {
      mode: "agent";
      principalId: string;
    };
    permissionScopeHash: string;
    permissionsVersion: number;
    schemaEpoch: number;
    workspaceId: string;
  }
): CommandEnvelope {
  if (!isRecord(value)) {
    throw new Error("agent tool command input must be an object.");
  }

  return {
    ...(value as Partial<CommandEnvelope>),
    actor: context.actor,
    permissionScopeHash: context.permissionScopeHash,
    permissionsVersion: context.permissionsVersion,
    schemaEpoch: context.schemaEpoch,
    workspaceId: context.workspaceId
  } as CommandEnvelope;
}

function serializeAgentToolResult(result: AgentToolInvocationResult): Record<string, unknown> {
  return result as unknown as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveAgentToolScope(
  toolId: AgentToolId,
  workspaceId: string,
  input: Record<string, unknown>
):
  | {
      ok: true;
      scope:
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
    }
  | {
      message: string;
      ok: false;
    } {
  if (toolId === "inspectWorkspace" || toolId === "createTable") {
    return {
      ok: true,
      scope: {
        kind: "workspace"
      }
    };
  }

  const directTableId = readNonEmptyString(input.tableId);
  const command = isRecord(input.command) ? input.command : null;
  const commandTableId = command ? readNonEmptyString(command.tableId) : null;
  const payload = command && isRecord(command.payload) ? command.payload : null;
  const payloadTableId = payload ? readNonEmptyString(payload.tableId) : null;
  const tableId = directTableId ?? commandTableId ?? payloadTableId;

  if (!tableId) {
    return {
      message: `A tableId is required to resolve permissions for agent tool ${toolId}.`,
      ok: false
    };
  }

  return {
    ok: true,
    scope: {
      kind: "table",
      tableId
    }
  };
}

async function resolveCommandPermissionScope(
  db: D1Database,
  command: Partial<CommandEnvelope>
): Promise<CommandPermissionScope> {
  const directTableId = readNonEmptyString(command.tableId);
  if (directTableId) {
    return {
      kind: "table",
      tableId: directTableId
    };
  }

  if (command.commandType === "workflow.create") {
    const payloadTableId = readWorkflowTriggerTableId(command.payload);
    if (payloadTableId) {
      return {
        kind: "table",
        tableId: payloadTableId
      };
    }
  }

  if (command.commandType === "workflow.publish" || command.commandType === "workflow.pause") {
    const workflowId = readNonEmptyString(command.payload?.workflowId);
    if (workflowId && typeof command.workspaceId === "string" && command.workspaceId.length > 0) {
      const workflowTableId = await readWorkflowTriggerTableIdFromDatabase(
        db,
        command.workspaceId,
        workflowId
      );
      if (workflowTableId) {
        return {
          kind: "table",
          tableId: workflowTableId
        };
      }
    }
  }

  if (command.commandType === "workflow.manual") {
    const workflowId = readNonEmptyString(command.payload?.workflowId);
    if (workflowId && typeof command.workspaceId === "string" && command.workspaceId.length > 0) {
      const workflowTableId = await readWorkflowTriggerTableIdFromDatabase(
        db,
        command.workspaceId,
        workflowId
      );
      if (workflowTableId) {
        return {
          kind: "table",
          tableId: workflowTableId
        };
      }
    }
  }

  return {
    kind: "workspace"
  };
}

async function resolveWorkflowOperationsAccess(
  env: CloudTableEnv,
  input: {
    deadLetterId?: string | null;
    permissionScopeHash?: string | null;
    policyRevisionValue?: string | null;
    principalId?: string | null;
    workflowId?: string | null;
    workflowRunId?: string | null;
    workspaceId?: string | null;
  }
):
  Promise<
    | {
        deadLetterId?: string;
        principalId: string;
        snapshot: EffectivePermissionSnapshot;
        workflowId: string;
        workflowRunId?: string;
        workspaceId: string;
      }
    | {
        response: Response;
      }
  > {
  const workspaceId = readNonEmptyString(input.workspaceId);
  if (!workspaceId) {
    return {
      response: badRequest("workspaceId query parameter is required.")
    };
  }

  const principalId = readNonEmptyString(input.principalId);
  if (!principalId) {
    return {
      response: badRequest("principalId is required for workflow operations ingress.")
    };
  }

  const policyRevision =
    typeof input.policyRevisionValue === "string" && input.policyRevisionValue.length > 0
      ? Number(input.policyRevisionValue)
      : null;
  if (
    input.policyRevisionValue != null &&
    (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
  ) {
    return {
      response: badRequest("policyRevision must be a finite number when provided for workflow operations ingress.")
    };
  }

  const workflowId =
    readNonEmptyString(input.workflowId) ??
    (input.workflowRunId
      ? await readWorkflowIdForRun(env.DB, input.workflowRunId)
      : input.deadLetterId
        ? await readWorkflowIdForDeadLetter(env.DB, input.deadLetterId)
        : null);
  if (!workflowId) {
    return {
      response: notFound("Workflow operational target was not found.")
    };
  }

  const tableId = await readWorkflowTriggerTableIdForWorkflow(env.DB, workspaceId, workflowId);
  const scope = tableId
    ? {
        kind: "table" as const,
        tableId
      }
    : {
        kind: "workspace" as const
      };

  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: createRuntime(env).fieldTypeRegistry,
    permissionScopeHash:
      typeof input.permissionScopeHash === "string" ? input.permissionScopeHash : undefined,
    policyRevision:
      typeof policyRevision === "number" ? policyRevision : undefined,
    principalId,
    scope,
    workspaceId
  });
  if (!resolvedSnapshot.ok) {
    return {
      response: badRequest(resolvedSnapshot.message)
    };
  }

  if (!workflowOperationsAuthorized(resolvedSnapshot.snapshot)) {
    return {
      response: forbidden(
        `Principal ${principalId} is not allowed to inspect or replay workflow operations for ${workflowId}.`
      )
    };
  }

  return {
    ...(input.deadLetterId ? { deadLetterId: input.deadLetterId } : {}),
    principalId,
    snapshot: resolvedSnapshot.snapshot,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    workflowId,
    workspaceId
  };
}

async function resolveSchemaMetadataAccess(
  env: CloudTableEnv,
  input: {
    permissionScopeHash?: string | null;
    policyRevisionValue?: string | null;
    principalId?: string | null;
    scope:
      | {
          kind: "table";
          tableId: string;
        }
      | {
          kind: "view";
          tableId: string;
          viewId: string;
        };
    workspaceId: string;
  }
): Promise<
  | {
      principalId: string;
      snapshot: EffectivePermissionSnapshot;
      workspaceId: string;
    }
  | {
      response: Response;
    }
> {
  const principalId = readNonEmptyString(input.principalId);
  if (!principalId) {
    return {
      response: badRequest("principalId is required for schema metadata ingress.")
    };
  }

  const policyRevision =
    typeof input.policyRevisionValue === "string" && input.policyRevisionValue.length > 0
      ? Number(input.policyRevisionValue)
      : null;
  if (
    input.policyRevisionValue != null &&
    (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
  ) {
    return {
      response: badRequest(
        "policyRevision must be a finite number when provided for schema metadata ingress."
      )
    };
  }

  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: createRuntime(env).fieldTypeRegistry,
    permissionScopeHash:
      typeof input.permissionScopeHash === "string" ? input.permissionScopeHash : undefined,
    policyRevision: typeof policyRevision === "number" ? policyRevision : undefined,
    principalId,
    scope: input.scope,
    workspaceId: input.workspaceId
  });
  if (!resolvedSnapshot.ok) {
    return {
      response: badRequest(resolvedSnapshot.message)
    };
  }

  return {
    principalId,
    snapshot: resolvedSnapshot.snapshot,
    workspaceId: input.workspaceId
  };
}

async function resolveWorkspaceCatalogAccess(
  env: CloudTableEnv,
  input: {
    permissionScopeHash?: string | null;
    policyRevisionValue?: string | null;
    principalId?: string | null;
    workspaceId: string;
  }
): Promise<
  | {
      principalId: string;
      workspaceId: string;
    }
  | {
      response: Response;
    }
> {
  const principalId = readNonEmptyString(input.principalId);
  if (!principalId) {
    return {
      response: badRequest("principalId is required for workspace catalog ingress.")
    };
  }

  const policyRevision =
    typeof input.policyRevisionValue === "string" && input.policyRevisionValue.length > 0
      ? Number(input.policyRevisionValue)
      : null;
  if (
    input.policyRevisionValue != null &&
    (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
  ) {
    return {
      response: badRequest(
        "policyRevision must be a finite number when provided for workspace catalog ingress."
      )
    };
  }

  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: createRuntime(env).fieldTypeRegistry,
    permissionScopeHash:
      typeof input.permissionScopeHash === "string" ? input.permissionScopeHash : undefined,
    policyRevision: typeof policyRevision === "number" ? policyRevision : undefined,
    principalId,
    scope: {
      kind: "workspace"
    },
    workspaceId: input.workspaceId
  });
  if (!resolvedSnapshot.ok) {
    return {
      response: badRequest(resolvedSnapshot.message)
    };
  }

  if (!workflowOperationsAuthorized(resolvedSnapshot.snapshot)) {
    return {
      response: forbidden(
        `Principal ${principalId} is not allowed to inspect workspace catalog metadata for ${input.workspaceId}.`
      )
    };
  }

  return {
    principalId,
    workspaceId: input.workspaceId
  };
}

function readWorkspaceInspectionInclude(searchParams: URLSearchParams):
  | {
      sections?: Array<"apps" | "tables" | "views" | "workflows" | "catalog">;
    }
  | {
      response: Response;
    } {
  const rawIncludes = searchParams
    .getAll("include")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (rawIncludes.length === 0) {
    return {};
  }

  const allowed = new Set(["apps", "tables", "views", "workflows", "catalog"]);
  const sections: Array<"apps" | "tables" | "views" | "workflows" | "catalog"> = [];
  const seen = new Set<string>();
  for (const value of rawIncludes) {
    if (!allowed.has(value)) {
      return {
        response: badRequest(
          `Unknown workspace catalog include section: ${value}. Expected one of apps, tables, views, workflows, catalog.`
        )
      };
    }

    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    sections.push(value as "apps" | "tables" | "views" | "workflows" | "catalog");
  }

  return {
    sections
  };
}

function serializeWorkflowOperatorManifest(definition: WorkflowOperatorDefinition): Record<string, unknown> {
  const base = {
    fixtureContract: definition.fixtureContract.map((fixture) => ({
      id: fixture.id,
      kind: fixture.kind
    })),
    id: definition.id,
    idempotencyMode: definition.idempotencyMode,
    inputSchema: definition.inputSchema,
    kind: definition.kind,
    outputSchema: definition.outputSchema,
    purity: definition.purity,
    requiredCapabilities: definition.requiredCapabilities,
    retryClass: definition.retryClass,
    timeoutClass: definition.timeoutClass,
    version: definition.version
  } satisfies Record<string, unknown>;

  if (definition.kind === "trigger") {
    return {
      ...base,
      triggerEventTypes: definition.triggerEventTypes
    };
  }

  if (definition.kind === "action") {
    return {
      ...base,
      commandScope: definition.commandScope,
      commandType: definition.commandType
    };
  }

  return base;
}

async function readWorkflowTriggerTableIdFromDatabase(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT workflow_versions.definition_json
       FROM workflows
       JOIN workflow_versions
         ON workflow_versions.workflow_id = workflows.id
        AND workflow_versions.workspace_id = workflows.workspace_id
        AND workflow_versions.version = workflows.current_version
       WHERE workflows.workspace_id = ? AND workflows.id = ? AND workflows.archived_at IS NULL`
    )
    .bind(workspaceId, workflowId)
    .first<{ definition_json: string }>();

  if (!row) {
    return null;
  }

  try {
    return readWorkflowTriggerTableId(JSON.parse(row.definition_json) as Record<string, unknown>);
  } catch {
    return null;
  }
}
