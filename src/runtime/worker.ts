import { serializeAgentToolManifest } from "../core/agent-tools/manifest";
import type {
  ArchiveFieldToolInput,
  ArchiveRecordToolInput,
  AgentToolId,
  AgentToolInvocation,
  AgentToolInvocationResult,
  BulkUpdateRecordsToolInput,
  ConfigureFieldPermissionToolInput,
  CreateAppToolInput,
  CreateRecordToolInput,
  CreateFieldToolInput,
  CreateTableToolInput,
  CreateViewToolInput,
  DeleteViewToolInput,
  DryRunCommandToolInput,
  ExplainPermissionsToolInput,
  ExecuteCommandToolInput,
  InspectAppToolInput,
  InspectWorkflowDefinitionToolInput,
  InspectTableSchemaToolInput,
  InspectViewDefinitionToolInput,
  InspectRecordToolInput,
  InspectWorkspaceToolInput,
  PauseWorkflowToolInput,
  PublishWorkflowToolInput,
  QueryViewToolInput,
  ReadActivityHistoryToolInput,
  ReadAppActivityHistoryToolInput,
  ReorderFieldsToolInput,
  ReadWorkspaceActivityHistoryToolInput,
  ReadWorkflowHistoryToolInput,
  ReadWorkflowRunDetailToolInput,
  WorkflowDeadLetterReplayToolInput,
  ProposeWorkflowToolInput,
  RunWorkflowToolInput,
  UpdateCellToolInput,
  UpdateFieldToolInput,
  UpdateRecordToolInput,
  UpdateWorkflowToolInput,
  UpdateViewToolInput
} from "../core/agent-tools/types";
import type { CommandEnvelope, CommandResult } from "../core/commands/types";
import { serializeFieldTypeManifest } from "../core/field-types/manifest";
import type { FieldTypeRegistry } from "../core/field-types/types";
import type { JsonValue } from "../core/field-types/types";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import type {
  PermissionEvaluationContext,
  PermissionProjectionInput
} from "../core/permissions/types";
import { aggregateDescriptorForCommand } from "../core/commands/domain";
import {
  dispatchCommandToCoordinator,
  matchCommandRoute
} from "./durable-object-dispatch";
import {
  readAppActivityHistory,
  readRecordActivityHistory,
  readTableActivityHistory,
  readWorkspaceActivityHistory
} from "./activity-history-read";
import { readRecordDetail, readRecordFields } from "./direct-record-read";
import { resolvePermissionSnapshot } from "./permission-snapshot";
import {
  SchemaMetadataAccessError,
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
import type { CloudTableRuntime } from "./bootstrap";
import { badRequest, conflict, forbidden, json, methodNotAllowed, notFound, unauthorized } from "./http";
import type { CloudTableEnv } from "./env";
import { enqueueScheduledWorkflowDispatches, requestManualAggregateMaintenance } from "./workflow-runtime";
import {
  readWorkflowDefinitionMetadata,
  readWorkflowExecutionCandidate,
  readWorkflowTriggerTableId
} from "./workflow-definition";
import { createWorkspaceInspector } from "./workspace-inspector";
import { serializeWorkflowOperatorManifest } from "../core/workflows/manifest";
import { createWorkflowOperatorRegistry } from "../core/workflows/operator-registry";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import type { AuthSessionRecord } from "../core/persistence/types";
import { drainPendingOutboxEntries } from "./queue-publisher";

type CommandPermissionScope =
  | {
      kind: "workspace";
    }
  | {
      kind: "table";
      tableId: string;
    };

type GoogleUserInfo = {
  email: string | null;
  name: string | null;
  subject: string;
};

type SignedTokenPayload = {
  invitationToken?: string;
  issuedAt: string;
  redirectTo: string;
  workspaceId?: string;
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
      fieldTypes: runtime.fieldTypeRegistry.list().map(serializeFieldTypeManifest),
      workflowOperators: runtime.workflowOperatorRegistry.list().map(serializeWorkflowOperatorManifest),
      agentTools: runtime.agentToolRegistry.list().map(serializeAgentToolManifest)
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/google/login") {
    const redirectTo = sanitizeRedirectTarget(url.searchParams.get("redirectTo"));
    if (!redirectTo) {
      return badRequest("redirectTo is required for Google login ingress.");
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.AUTH_SESSION_SECRET) {
      return badRequest("Google auth ingress is not configured.");
    }

    const state = await encodeSignedToken(
      {
        ...(readNonEmptyString(url.searchParams.get("invitationToken"))
          ? { invitationToken: readNonEmptyString(url.searchParams.get("invitationToken"))! }
          : {}),
        issuedAt: new Date().toISOString(),
        redirectTo,
        ...(readNonEmptyString(url.searchParams.get("workspaceId"))
          ? { workspaceId: readNonEmptyString(url.searchParams.get("workspaceId"))! }
          : {})
      },
      env.AUTH_SESSION_SECRET
    );
    const redirectUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    redirectUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    redirectUrl.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URI);
    redirectUrl.searchParams.set("response_type", "code");
    redirectUrl.searchParams.set("scope", "openid email profile");
    redirectUrl.searchParams.set("state", state);

    return new Response(null, {
      status: 302,
      headers: {
        location: redirectUrl.toString()
      }
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/google/callback") {
    return handleGoogleAuthCallback(request, env);
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/session") {
    return handleSessionIngress(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/session/selection") {
    return handleSessionSelectionIngress(request, env);
  }

  const workspaceInvitationCollectionMatch = url.pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/invitations$/
  );
  if (workspaceInvitationCollectionMatch && request.method === "POST") {
    return handleInvitationIssuance(request, env, workspaceInvitationCollectionMatch[1]!);
  }

  const workspaceMembershipCollectionMatch = url.pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/memberships$/
  );
  if (workspaceMembershipCollectionMatch && request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) as Record<string, unknown>) ?? {};
    } catch {
      return badRequest("Request body must be valid JSON.");
    }

    const workspaceId = workspaceMembershipCollectionMatch[1]!;
    const stub = env.WORKSPACE_CONTROL_DO.get(env.WORKSPACE_CONTROL_DO.idFromName(workspaceId));
    return stub.fetch(
      new Request(new URL("/memberships", url.origin), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...body,
          workspace: {
            ...((isRecord(body.workspace) ? body.workspace : {}) as Record<string, unknown>),
            id: workspaceId
          }
        })
      })
    );
  }

  const workspaceMembershipDetailMatch = url.pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/memberships\/([^/]+)$/
  );
  if (workspaceMembershipDetailMatch && request.method === "GET") {
    const workspaceId = workspaceMembershipDetailMatch[1]!;
    const principalId = workspaceMembershipDetailMatch[2]!;
    const stub = env.WORKSPACE_CONTROL_DO.get(env.WORKSPACE_CONTROL_DO.idFromName(workspaceId));
    return stub.fetch(
      new Request(
        new URL(
          `/memberships/${encodeURIComponent(principalId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
          url.origin
        ),
        {
          method: "GET"
        }
      )
    );
  }

  const workspaceActivityMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/activity$/);
  if (workspaceActivityMatch && request.method === "GET") {
    const workspaceId = workspaceActivityMatch[1]!;
    const principalId = url.searchParams.get("principalId");
    const policyRevisionValue = url.searchParams.get("policyRevision");
    const policyRevision =
      typeof policyRevisionValue === "string" && policyRevisionValue.length > 0
        ? Number(policyRevisionValue)
        : null;
    const permissionScopeHash = url.searchParams.get("permissionScopeHash");

    if (!principalId && (policyRevisionValue !== null || permissionScopeHash !== null)) {
      return badRequest(
        "principalId query parameter is required when permission coordinates are provided for workspace activity reads."
      );
    }

    if (
      policyRevisionValue !== null &&
      (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
    ) {
      return badRequest(
        "policyRevision must be a finite number when provided for permissioned workspace activity reads."
      );
    }

    const limit = readActivityLimit(url);
    if ("response" in limit) {
      return limit.response;
    }

    const beforeWorkspaceSequence = readActivityBeforeWorkspaceSequence(url);
    if ("response" in beforeWorkspaceSequence) {
      return beforeWorkspaceSequence.response;
    }

    if (principalId) {
      const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
        fieldTypeRegistry: runtime.fieldTypeRegistry,
        permissionScopeHash,
        policyRevision,
        principalId,
        scope: {
          kind: "workspace"
        },
        workspaceId
      });

      if (!resolvedSnapshot.ok) {
        return badRequest(resolvedSnapshot.message);
      }
    }

    const history = await readWorkspaceActivityHistory(env.DB, runtime.fieldTypeRegistry, {
      beforeWorkspaceSequence: beforeWorkspaceSequence.value,
      limit: limit.value,
      workspaceId
    });

    return json({
      entries: history.entries,
      page: {
        limit: limit.value,
        nextBeforeWorkspaceSequence: history.nextBeforeWorkspaceSequence
      },
      workspaceId
    });
  }

  const appActivityMatch = url.pathname.match(/^\/v1\/apps\/([^/]+)\/activity$/);
  const appDetailMatch =
    url.pathname.match(/^\/v1\/apps\/([^/]+)$/) ?? url.pathname.match(/^\/v1\/bases\/([^/]+)$/);
  if (appDetailMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return badRequest("workspaceId query parameter is required.");
    }

    const auth = await resolveWorkspaceCatalogAccess(request, env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    const app = await runtime.appInspector.inspect({
      appId: appDetailMatch[1]!,
      workspaceId
    });
    if (!app) {
      return notFound(`App ${appDetailMatch[1]!} was not found.`);
    }

    return json(app);
  }

  if (appActivityMatch && request.method === "GET") {
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
        "principalId query parameter is required when permission coordinates are provided for app activity reads."
      );
    }

    if (
      policyRevisionValue !== null &&
      (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
    ) {
      return badRequest(
        "policyRevision must be a finite number when provided for permissioned app activity reads."
      );
    }

    const limit = readActivityLimit(url);
    if ("response" in limit) {
      return limit.response;
    }

    const beforeWorkspaceSequence = readActivityBeforeWorkspaceSequence(url);
    if ("response" in beforeWorkspaceSequence) {
      return beforeWorkspaceSequence.response;
    }

    const [, appId] = appActivityMatch;
    const appExists = await readAppExists(env.DB, {
      appId,
      workspaceId
    });
    if (!appExists) {
      return notFound(`App ${appId} was not found.`);
    }

    if (principalId) {
      const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
        fieldTypeRegistry: runtime.fieldTypeRegistry,
        permissionScopeHash,
        policyRevision,
        principalId,
        scope: {
          kind: "workspace"
        },
        workspaceId
      });

      if (!resolvedSnapshot.ok) {
        return badRequest(resolvedSnapshot.message);
      }
    }

    const history = await readAppActivityHistory(env.DB, runtime.fieldTypeRegistry, {
      appId,
      beforeWorkspaceSequence: beforeWorkspaceSequence.value,
      limit: limit.value,
      workspaceId
    });

    return json({
      appId,
      entries: history.entries,
      page: {
        limit: limit.value,
        nextBeforeWorkspaceSequence: history.nextBeforeWorkspaceSequence
      },
      workspaceId
    });
  }

  const workspaceCatalogMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/catalog$/);
  if (workspaceCatalogMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = workspaceCatalogMatch[1]!;
    const auth = await resolveWorkspaceCatalogAccess(request, env, {
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
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      () => runtime.agentToolRegistry
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
    const auth = await resolveWorkspaceCatalogAccess(request, env, {
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

  const fieldTypeCatalogMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/field-types$/);
  if (fieldTypeCatalogMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = fieldTypeCatalogMatch[1]!;
    const auth = await resolveWorkspaceCatalogAccess(request, env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    return json({
      fieldTypes: runtime.fieldTypeRegistry.list().map(serializeFieldTypeManifest),
      workspaceId
    });
  }

  const agentToolCatalogMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/agent-tools$/);
  if (agentToolCatalogMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = agentToolCatalogMatch[1]!;
    const auth = await resolveWorkspaceCatalogAccess(request, env, {
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision"),
      principalId: url.searchParams.get("principalId"),
      workspaceId
    });
    if ("response" in auth) {
      return auth.response;
    }

    return json({
      agentTools: runtime.agentToolRegistry.list().map(serializeAgentToolManifest),
      workspaceId
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
    const auth = await resolveSchemaMetadataAccess(request, env, {
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

    const detail = await readTableSchemaMetadata(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        tableId,
        workspaceId
      }
    );
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
    const auth = await resolveSchemaMetadataAccess(request, env, {
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

  if (url.pathname === "/v1/permissions/explain") {
    return handlePermissionExplanationIngress(request, env, runtime);
  }

  if (url.pathname === "/v1/permissions/persona-preview") {
    return handlePermissionPersonaPreviewIngress(request, env, runtime);
  }

  if (url.pathname === "/v1/agent-tools/preview") {
    return handleAgentToolIngress(request, env, "preview");
  }

  if (url.pathname === "/v1/agent-tools/execute") {
    return handleAgentToolIngress(request, env, "execute");
  }

  if (url.pathname === "/v1/permissions/explain") {
    return handlePermissionExplainIngress(request, env);
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

    const auth = await resolveWorkflowOperationsAccess(request, env, {
      principalId: url.searchParams.get("principalId"),
      workflowId: workflowDefinitionMatch[1] ?? null,
      workspaceId: url.searchParams.get("workspaceId"),
      permissionScopeHash: url.searchParams.get("permissionScopeHash"),
      policyRevisionValue: url.searchParams.get("policyRevision")
    });
    if ("response" in auth) {
      return auth.response;
    }

    const detail = await readWorkflowDefinitionMetadata(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.workflowOperatorRegistry,
      auth.workspaceId,
      auth.workflowId
    );
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

    const auth = await resolveWorkflowOperationsAccess(request, env, {
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

  const workflowAggregateMaintenanceMatch = url.pathname.match(
    /^\/v1\/workflows\/([^/]+)\/aggregate-maintenance$/
  );
  if (workflowAggregateMaintenanceMatch) {
    if (request.method !== "POST") {
      return methodNotAllowed(request.method, ["POST"]);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return badRequest("Workflow aggregate-maintenance body must be valid JSON.");
    }

    const auth = await resolveWorkflowOperationsAccess(request, env, {
      principalId: readNonEmptyString(body.principalId),
      workflowId: workflowAggregateMaintenanceMatch[1] ?? null,
      workspaceId: readNonEmptyString(body.workspaceId),
      permissionScopeHash: readNonEmptyString(body.permissionScopeHash),
      policyRevisionValue:
        typeof body.policyRevision === "number" ? String(body.policyRevision) : null
    });
    if ("response" in auth) {
      return auth.response;
    }

    const kind = readNonEmptyString(body.kind);
    if (kind !== "backfill" && kind !== "recompute") {
      return badRequest("kind must be either backfill or recompute.");
    }

    const aggregateAliasesValue = body.aggregateAliases;
    if (aggregateAliasesValue !== undefined && !Array.isArray(aggregateAliasesValue)) {
      return badRequest("aggregateAliases must be an array of strings when provided.");
    }
    const aggregateAliases = Array.isArray(aggregateAliasesValue)
      ? Array.from(
          new Set(
            aggregateAliasesValue.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0
            )
          )
        )
      : undefined;
    if (Array.isArray(aggregateAliasesValue) && aggregateAliases?.length !== aggregateAliasesValue.length) {
      return badRequest("aggregateAliases entries must all be non-empty strings.");
    }

    const changedFieldIdsValue = body.changedFieldIds;
    if (changedFieldIdsValue !== undefined && !Array.isArray(changedFieldIdsValue)) {
      return badRequest("changedFieldIds must be an array of strings when provided.");
    }
    const changedFieldIds = Array.isArray(changedFieldIdsValue)
      ? Array.from(
          new Set(
            changedFieldIdsValue.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0
            )
          )
        )
      : undefined;
    if (Array.isArray(changedFieldIdsValue) && changedFieldIds?.length !== changedFieldIdsValue.length) {
      return badRequest("changedFieldIds entries must all be non-empty strings.");
    }

    const requestId =
      readNonEmptyString(body.requestId) ??
      readNonEmptyString(body.idempotencyKey) ??
      `workflow-aggregate-maintenance:${workflowAggregateMaintenanceMatch[1]!}:${kind}`;
    const result = await requestManualAggregateMaintenance(env, {
      aggregateAliases,
      changedFieldIds,
      kind,
      principalId: auth.principalId,
      reason: readNonEmptyString(body.reason) ?? undefined,
      recordId: readNonEmptyString(body.recordId),
      requestId,
      workflowId: workflowAggregateMaintenanceMatch[1]!,
      workspaceId: auth.workspaceId
    });

    if (!result.ok) {
      if (result.reason === "workflow_not_found") {
        return notFound(result.message);
      }
      if (result.reason === "already_requested") {
        return conflict(result.message);
      }
      return badRequest(result.message);
    }

    return json(
      {
        aggregateAliases: result.aggregateAliases,
        kind,
        requestId,
        status: result.status,
        workflowId: workflowAggregateMaintenanceMatch[1]!,
        workflowVersionId: result.workflowVersionId
      },
      { status: 202 }
    );
  }

  const workflowRunHistoryMatch = url.pathname.match(/^\/v1\/workflow-runs\/([^/]+)$/);
  if (workflowRunHistoryMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const auth = await resolveWorkflowOperationsAccess(request, env, {
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

    const auth = await resolveWorkflowOperationsAccess(request, env, {
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
  const recordActivityMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/records\/([^/]+)\/activity$/);
  if (recordActivityMatch && request.method === "GET") {
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
        "principalId query parameter is required when permission coordinates are provided for record activity reads."
      );
    }

    if (
      policyRevisionValue !== null &&
      (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
    ) {
      return badRequest(
        "policyRevision must be a finite number when provided for permissioned record activity reads."
      );
    }

    const limit = readActivityLimit(url);
    if ("response" in limit) {
      return limit.response;
    }

    const beforeTableSequence = readActivityBeforeTableSequence(url);
    if ("response" in beforeTableSequence) {
      return beforeTableSequence.response;
    }

    const [, tableId, recordId] = recordActivityMatch;
    const detail = await readRecordDetail(env.DB, workspaceId, tableId, recordId);
    if (!detail) {
      return notFound(`Record ${recordId} was not found in table ${tableId}.`);
    }

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
    }

    const history = await readRecordActivityHistory(env.DB, runtime.fieldTypeRegistry, {
      beforeTableSequence: beforeTableSequence.value,
      limit: limit.value,
      recordId,
      tableId,
      workspaceId
    });

    return json({
      entries: history.entries,
      page: {
        limit: limit.value,
        nextBeforeTableSequence: history.nextBeforeTableSequence
      },
      record: {
        ...detail.record,
        lastEventId: detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
      },
      workspaceId
    });
  }

  const tableActivityMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/activity$/);
  if (tableActivityMatch && request.method === "GET") {
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
        "principalId query parameter is required when permission coordinates are provided for table activity reads."
      );
    }

    if (
      policyRevisionValue !== null &&
      (typeof policyRevision !== "number" || Number.isNaN(policyRevision))
    ) {
      return badRequest(
        "policyRevision must be a finite number when provided for permissioned table activity reads."
      );
    }

    const limit = readActivityLimit(url);
    if ("response" in limit) {
      return limit.response;
    }

    const beforeTableSequence = readActivityBeforeTableSequence(url);
    if ("response" in beforeTableSequence) {
      return beforeTableSequence.response;
    }

    const [, tableId] = tableActivityMatch;
    const table = await readTableSchemaMetadata(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        tableId,
        workspaceId
      }
    );
    if (!table) {
      return notFound(`Table ${tableId} was not found.`);
    }

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
    }

    const history = await readTableActivityHistory(env.DB, runtime.fieldTypeRegistry, {
      beforeTableSequence: beforeTableSequence.value,
      limit: limit.value,
      tableId,
      workspaceId
    });

    return json({
      entries: history.entries,
      page: {
        limit: limit.value,
        nextBeforeTableSequence: history.nextBeforeTableSequence
      },
      tableId,
      workspaceId
    });
  }

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
    const recordFields = rawProjection
      ? await readRecordFields(env.DB, workspaceId, tableId)
      : [];
    const orderedProjection =
      rawProjection === null
        ? null
        : recordFields.length === 0
          ? rawProjection
          : {
              fields: Object.fromEntries(
                recordFields
                  .filter((field) =>
                    Object.prototype.hasOwnProperty.call(rawProjection.fields ?? {}, field.field_key)
                  )
                  .map((field) => [field.field_key, rawProjection.fields?.[field.field_key] ?? null])
              )
            };
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
      projection: orderedProjection,
      projectionVersion: detail.projection?.projection_version ?? 0,
      record: {
        ...detail.record,
        lastEventId:
          detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
      }
    });
  }

  const viewGroupMoveMatch = url.pathname.match(
    /^\/v1\/tables\/([^/]+)\/views\/([^/]+)\/records\/([^/]+)\/group-move$/
  );
  if (viewGroupMoveMatch && request.method === "POST") {
    const bodyOrResponse = await readCommandIngressBody(request);
    if (bodyOrResponse instanceof Response) {
      return bodyOrResponse;
    }

    const [, tableId, viewId, recordId] = viewGroupMoveMatch;
    return handleGroupedViewMove(request, env, runtime, {
      body: bodyOrResponse,
      recordId,
      tableId,
      viewId
    });
  }

  const viewCreateMatch = url.pathname.match(/^\/v1\/tables\/([^/]+)\/views\/([^/]+)\/records$/);
  if (viewCreateMatch && request.method === "POST") {
    const bodyOrResponse = await readCommandIngressBody(request);
    if (bodyOrResponse instanceof Response) {
      return bodyOrResponse;
    }

    const [, tableId, viewId] = viewCreateMatch;
    return handleViewScopedRecordCreate(request, env, runtime, {
      body: bodyOrResponse,
      tableId,
      viewId
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
    return json(
      {
        ...responseBody,
        aggregate: aggregateDescriptorForCommand(normalized.command)
      },
      {
        status: response.status
      }
    );
  }

  return notFound("CloudTable route not found.");
}

export async function handleScheduled(
  controller: ScheduledController,
  env: CloudTableEnv,
  _ctx: ExecutionContext
): Promise<void> {
  await enqueueScheduledWorkflowDispatches(env, controller.scheduledTime);
  const runtime = createRuntime(env);
  const repository = createCloudTableD1Repository(env.DB, runtime.fieldTypeRegistry);
  await drainPendingOutboxEntries(
    env,
    repository,
    new Date(controller.scheduledTime).toISOString()
  );
}

async function handleGoogleAuthCallback(request: Request, env: CloudTableEnv): Promise<Response> {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_OAUTH_REDIRECT_URI ||
    !env.AUTH_SESSION_SECRET
  ) {
    return badRequest("Google auth ingress is not configured.");
  }

  const url = new URL(request.url);
  const code = readNonEmptyString(url.searchParams.get("code"));
  const state = readNonEmptyString(url.searchParams.get("state"));
  if (!code || !state) {
    return badRequest("Google auth callback requires code and state.");
  }

  const decodedState = await decodeSignedToken<SignedTokenPayload>(state, env.AUTH_SESSION_SECRET);
  if (!decodedState || !sanitizeRedirectTarget(decodedState.redirectTo)) {
    return badRequest("Google auth callback state is invalid.");
  }

  const googleIdentity = await exchangeGoogleCodeForUserInfo(env, code);
  if (!googleIdentity.ok) {
    return googleIdentity.response;
  }

  if (!googleIdentity.user.email) {
    return forbidden("Google identity did not include an email address.");
  }

  const repository = createCloudTableD1Repository(env.DB, createRuntime(env).fieldTypeRegistry);
  const existingLinkedUser = await repository.findUserByExternalIdentity({
    externalSubject: googleIdentity.user.subject,
    providerKey: "google"
  });
  const emailMatchedUser = await repository.findUserByEmail(googleIdentity.user.email);
  const invitationToken = readNonEmptyString(decodedState.invitationToken);
  const invitation =
    invitationToken == null
      ? null
      : await repository.findInvitationByTokenHash(await sha256Hex(invitationToken));

  if (
    existingLinkedUser &&
    emailMatchedUser &&
    existingLinkedUser.userId !== emailMatchedUser.userId
  ) {
    return conflict(
      `Google identity ${googleIdentity.user.subject} is already linked to a different CloudTable user.`,
      {
        conflictingUserId: existingLinkedUser.userId,
        emailMatchedUserId: emailMatchedUser.userId
      }
    );
  }

  if (invitationToken && !invitation) {
    return forbidden("Invitation token is invalid or has been revoked.");
  }

  if (invitation) {
    if (invitation.status !== "pending") {
      return conflict(`Invitation ${invitation.id} is no longer pending.`);
    }

    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      return forbidden(`Invitation ${invitation.id} has expired.`);
    }

    if (googleIdentity.user.email.toLowerCase() !== invitation.invitedEmail.toLowerCase()) {
      return forbidden(
        `Invitation ${invitation.id} is for ${invitation.invitedEmail}, not ${googleIdentity.user.email}.`
      );
    }
  }

  let canonicalUser = existingLinkedUser ?? emailMatchedUser;
  if (!canonicalUser && !invitation) {
    return forbidden(
      `No canonical CloudTable user is linked to ${googleIdentity.user.email}. Invitation acceptance is not available on this ingress yet.`
    );
  }

  if (invitation) {
    const existingMembership = canonicalUser
      ? await repository.readWorkspaceMembershipIdentityForUser({
          userId: canonicalUser.userId,
          workspaceId: invitation.workspaceId
        })
      : null;
    const acceptedUserId = canonicalUser?.userId ?? generateStableIdentifier("user");
    const acceptedMembership = await repository.acceptInvitation({
      acceptedByUserId: acceptedUserId,
      acceptedDisplayName: googleIdentity.user.name,
      acceptedEmail: googleIdentity.user.email,
      acceptedExternalIdentity: {
        email: googleIdentity.user.email,
        externalSubject: googleIdentity.user.subject,
        id: `ext_google_${googleIdentity.user.subject}`,
        providerKey: "google"
      },
      acceptedPrincipalId: existingMembership?.principalId ?? generateStableIdentifier("usr"),
      acceptedUserId,
      invitationId: invitation.id,
      organizationMembershipId:
        existingMembership?.organizationMembershipId ?? generateStableIdentifier("orgmem"),
      timestamp: new Date().toISOString(),
      workspaceMembershipId:
        existingMembership?.workspaceMembershipId ?? generateStableIdentifier("wsmem")
    });
    if (!acceptedMembership) {
      return conflict(`Invitation ${invitation.id} could not be accepted.`);
    }

    canonicalUser = {
      displayName: acceptedMembership.userDisplayName,
      primaryEmail: acceptedMembership.userEmail,
      userId: acceptedMembership.userId
    };
  }
  if (!canonicalUser) {
    return conflict("Google callback could not resolve a canonical CloudTable user.");
  }

  const linkResult = await repository.linkExternalIdentityToUser({
    email: googleIdentity.user.email,
    externalIdentityId: `ext_google_${googleIdentity.user.subject}`,
    externalSubject: googleIdentity.user.subject,
    providerKey: "google",
    timestamp: new Date().toISOString(),
    userId: canonicalUser.userId
  });
  if (linkResult === "conflict") {
    return conflict(
      `Google identity ${googleIdentity.user.subject} is already linked to a different CloudTable user.`
    );
  }

  const sessionTtlSeconds = readSessionTtlSeconds(env);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + sessionTtlSeconds * 1000);
  const session = await repository.createAuthSession({
    activeWorkspaceId: await resolveInitialActiveWorkspaceId({
      invitationWorkspaceId: invitation?.workspaceId ?? null,
      repository,
      requestedWorkspaceId: decodedState.workspaceId ?? null,
      userId: canonicalUser.userId
    }),
    expiresAt: expiresAt.toISOString(),
    lastAuthenticatedAt: issuedAt.toISOString(),
    sessionId: crypto.randomUUID(),
    userId: canonicalUser.userId
  });
  const sessionCookie = await encodeSignedToken(
    { sessionId: session.sessionId },
    env.AUTH_SESSION_SECRET
  );

  return new Response(null, {
    status: 302,
    headers: {
      "set-cookie": serializeSessionCookie(env, sessionCookie, expiresAt),
      location: decodedState.redirectTo
    }
  });
}

async function handleInvitationIssuance(
  request: Request,
  env: CloudTableEnv,
  workspaceId: string
): Promise<Response> {
  const authSession = await resolveAuthenticatedSession(request, env);
  if ("response" in authSession) {
    return authSession.response;
  }

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) as Record<string, unknown>) ?? {};
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const invitedEmail = readNonEmptyString(body.email)?.toLowerCase();
  if (!invitedEmail) {
    return badRequest("email is required for invitation issuance.");
  }

  const redirectTo = sanitizeRedirectTarget(readNonEmptyString(body.redirectTo));
  if (!redirectTo) {
    return badRequest("redirectTo is required for invitation issuance.");
  }

  const expiresAt = parseInvitationExpiry(body.expiresAt);
  if (!expiresAt) {
    return badRequest("expiresAt must be a valid ISO-8601 timestamp when provided.");
  }

  const repository = createCloudTableD1Repository(env.DB, createRuntime(env).fieldTypeRegistry);
  const inviterMembership = await repository.readWorkspaceMembershipIdentityForUser({
    userId: authSession.session.userId,
    workspaceId
  });
  if (!inviterMembership) {
    return forbidden(
      `Authenticated user ${authSession.session.userId} is not an active workspace member for ${workspaceId}.`
    );
  }

  const rawToken = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const invitation = await repository.createInvitation({
    expiresAt: expiresAt.toISOString(),
    id: generateStableIdentifier("inv"),
    invitedByUserId: authSession.session.userId,
    invitedEmail,
    roleKey: readNonEmptyString(body.roleKey) ?? "workspace.member",
    timestamp: new Date().toISOString(),
    tokenHash: await sha256Hex(rawToken),
    workspaceId
  });
  if (!invitation) {
    return notFound(`Workspace ${workspaceId} is missing invitation context.`);
  }

  const acceptUrl = new URL("/v1/auth/google/login", new URL(request.url).origin);
  acceptUrl.searchParams.set("invitationToken", rawToken);
  acceptUrl.searchParams.set("redirectTo", redirectTo);
  acceptUrl.searchParams.set("workspaceId", invitation.workspaceId);

  return json(
    {
      invitation: {
        ...invitation,
        acceptUrl: acceptUrl.toString()
      }
    },
    { status: 201 }
  );
}

async function handleSessionIngress(request: Request, env: CloudTableEnv): Promise<Response> {
  const authSession = await resolveAuthenticatedSession(request, env);
  if ("response" in authSession) {
    return authSession.response;
  }

  const repository = createCloudTableD1Repository(env.DB, createRuntime(env).fieldTypeRegistry);
  const memberships = await repository.listWorkspaceMembershipIdentitiesForUser(authSession.session.userId);
  const requestedWorkspaceId = readNonEmptyString(new URL(request.url).searchParams.get("workspaceId"));
  const selectedMembership = selectWorkspaceMembership({
    memberships,
    requestedWorkspaceId,
    sessionActiveWorkspaceId: authSession.session.activeWorkspaceId
  });

  return json({
    activeOrganization:
      selectedMembership == null
        ? null
        : {
            organizationId: selectedMembership.organizationId,
            organizationName: selectedMembership.organizationName,
            organizationSlug: selectedMembership.organizationSlug
          },
    activeWorkspaceId: selectedMembership?.workspaceId ?? null,
    activeWorkspaceMembership: selectedMembership,
    memberships,
    session: authSession.session,
    ...(selectedMembership ? { workspaceMembership: selectedMembership } : {})
  });
}

async function handleSessionSelectionIngress(
  request: Request,
  env: CloudTableEnv
): Promise<Response> {
  const authSession = await resolveAuthenticatedSession(request, env);
  if ("response" in authSession) {
    return authSession.response;
  }

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) as Record<string, unknown>) ?? {};
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const workspaceId = readNonEmptyString(
    typeof body.workspaceId === "string" ? body.workspaceId : null
  );
  if (!workspaceId) {
    return badRequest("workspaceId is required for session context switching.");
  }

  const repository = createCloudTableD1Repository(env.DB, createRuntime(env).fieldTypeRegistry);
  const membership = await repository.readWorkspaceMembershipIdentityForUser({
    userId: authSession.session.userId,
    workspaceId
  });
  if (!membership) {
    return forbidden(
      `Authenticated user ${authSession.session.userId} is not an active workspace member for ${workspaceId}.`
    );
  }

  const updatedSession = await repository.updateAuthSessionActiveWorkspace({
    activeWorkspaceId: workspaceId,
    sessionId: authSession.session.sessionId
  });
  if (!updatedSession) {
    return unauthorized("CloudTable auth session is missing or expired.");
  }

  const memberships = await repository.listWorkspaceMembershipIdentitiesForUser(updatedSession.userId);
  return json({
    activeOrganization: {
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      organizationSlug: membership.organizationSlug
    },
    activeWorkspaceId: membership.workspaceId,
    activeWorkspaceMembership: membership,
    memberships,
    session: updatedSession,
    workspaceMembership: membership
  });
}

async function exchangeGoogleCodeForUserInfo(
  env: CloudTableEnv,
  code: string
): Promise<{ ok: true; user: GoogleUserInfo } | { ok: false; response: Response }> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!
    }).toString()
  });
  if (!tokenResponse.ok) {
    return {
      ok: false,
      response: forbidden("Google token exchange failed.", {
        status: tokenResponse.status
      })
    };
  }

  const tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
  const accessToken = readNonEmptyString(tokenBody.access_token);
  if (!accessToken) {
    return {
      ok: false,
      response: forbidden("Google token exchange did not return an access token.")
    };
  }

  const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });
  if (!userInfoResponse.ok) {
    return {
      ok: false,
      response: forbidden("Google userinfo lookup failed.", {
        status: userInfoResponse.status
      })
    };
  }

  const userInfo = (await userInfoResponse.json()) as Record<string, unknown>;
  const subject = readNonEmptyString(userInfo.sub);
  if (!subject) {
    return {
      ok: false,
      response: forbidden("Google userinfo payload did not include a subject.")
    };
  }

  return {
    ok: true,
    user: {
      email: readNonEmptyString(userInfo.email) ?? null,
      name: readNonEmptyString(userInfo.name) ?? null,
      subject
    }
  };
}

async function resolveAuthenticatedSession(
  request: Request,
  env: CloudTableEnv
): Promise<{ session: AuthSessionRecord } | { response: Response }> {
  if (!env.AUTH_SESSION_SECRET) {
    return {
      response: unauthorized("Session auth is not configured.")
    };
  }

  const rawCookie = readCookie(request, sessionCookieName(env));
  if (!rawCookie) {
    return {
      response: unauthorized("No CloudTable auth session cookie is present.")
    };
  }

  const decoded = await decodeSignedToken<{ sessionId: string }>(rawCookie, env.AUTH_SESSION_SECRET);
  if (!decoded?.sessionId) {
    return {
      response: unauthorized("CloudTable auth session cookie is invalid.")
    };
  }

  const repository = createCloudTableD1Repository(env.DB, createRuntime(env).fieldTypeRegistry);
  const session = await repository.readAuthSession(decoded.sessionId);
  if (!session) {
    return {
      response: unauthorized("CloudTable auth session is missing or expired.")
    };
  }

  return { session };
}

async function resolveSessionPrincipalForWorkspace(
  request: Request,
  env: CloudTableEnv,
  workspaceId: string
): Promise<{ principalId: string } | { response: Response }> {
  const authSession = await resolveAuthenticatedSession(request, env);
  if ("response" in authSession) {
    return authSession;
  }

  const repository = createCloudTableD1Repository(env.DB, createRuntime(env).fieldTypeRegistry);
  const membership = await repository.readWorkspaceMembershipIdentityForUser({
    userId: authSession.session.userId,
    workspaceId
  });
  if (!membership) {
    return {
      response: forbidden(
        `Authenticated user ${authSession.session.userId} is not an active workspace member for ${workspaceId}.`
      )
    };
  }

  return {
    principalId: membership.principalId
  };
}

async function resolveInitialActiveWorkspaceId(input: {
  invitationWorkspaceId: string | null;
  repository: ReturnType<typeof createCloudTableD1Repository>;
  requestedWorkspaceId: string | null;
  userId: string;
}): Promise<string | null> {
  if (input.invitationWorkspaceId) {
    return input.invitationWorkspaceId;
  }

  if (input.requestedWorkspaceId) {
    const requestedMembership = await input.repository.readWorkspaceMembershipIdentityForUser({
      userId: input.userId,
      workspaceId: input.requestedWorkspaceId
    });
    if (requestedMembership) {
      return requestedMembership.workspaceId;
    }
  }

  const memberships = await input.repository.listWorkspaceMembershipIdentitiesForUser(input.userId);
  return memberships.length === 1 ? memberships[0]!.workspaceId : null;
}

function selectWorkspaceMembership(input: {
  memberships: Array<{
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    workspaceId: string;
  }>;
  requestedWorkspaceId: string | null;
  sessionActiveWorkspaceId: string | null;
}) {
  if (input.requestedWorkspaceId) {
    return input.memberships.find((membership) => membership.workspaceId === input.requestedWorkspaceId) ?? null;
  }

  if (input.sessionActiveWorkspaceId) {
    return (
      input.memberships.find((membership) => membership.workspaceId === input.sessionActiveWorkspaceId) ?? null
    );
  }

  return null;
}

function sanitizeRedirectTarget(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    if (value.startsWith("/")) {
      return value;
    }

    return null;
  }
}

function sessionCookieName(env: CloudTableEnv): string {
  return env.AUTH_COOKIE_NAME?.trim() || "cloudtable_session";
}

function readSessionTtlSeconds(env: CloudTableEnv): number {
  const raw = env.AUTH_SESSION_TTL_SECONDS?.trim();
  if (!raw) {
    return 60 * 60 * 24 * 7;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60 * 60 * 24 * 7;
}

function serializeSessionCookie(env: CloudTableEnv, value: string, expiresAt: Date): string {
  return `${sessionCookieName(env)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

async function encodeSignedToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = toBase64Url(JSON.stringify(payload));
  const signature = await signValue(body, secret);
  return `${body}.${signature}`;
}

async function decodeSignedToken<T>(value: string, secret: string): Promise<T | null> {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }

  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = await signValue(body, secret);
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }

  try {
    return JSON.parse(fromBase64Url(body)) as T;
  } catch {
    return null;
  }
}

async function signValue(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      hash: "SHA-256",
      name: "HMAC"
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(signature);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function toBase64Url(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

function parseInvitationExpiry(value: unknown): Date | null {
  if (value == null) {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  const parsed = readNonEmptyString(value);
  if (!parsed) {
    return null;
  }

  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function generateStableIdentifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readActivityLimit(url: URL): { value: number } | { response: Response } {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit === null || rawLimit.length === 0) {
    return {
      value: 25
    };
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    return {
      response: badRequest("limit must be an integer between 1 and 100 for activity history reads.")
    };
  }

  return {
    value: limit
  };
}

function readActivityBeforeTableSequence(
  url: URL
): { value: number | null } | { response: Response } {
  const rawBefore = url.searchParams.get("beforeTableSequence");
  if (rawBefore === null || rawBefore.length === 0) {
    return {
      value: null
    };
  }

  const beforeTableSequence = Number(rawBefore);
  if (!Number.isInteger(beforeTableSequence) || beforeTableSequence <= 0) {
    return {
      response: badRequest(
        "beforeTableSequence must be a positive integer when provided for activity history reads."
      )
    };
  }

  return {
    value: beforeTableSequence
  };
}

function readActivityBeforeWorkspaceSequence(
  url: URL
): { value: number | null } | { response: Response } {
  const rawBefore = url.searchParams.get("beforeWorkspaceSequence");
  if (rawBefore === null || rawBefore.length === 0) {
    return {
      value: null
    };
  }

  const beforeWorkspaceSequence = Number(rawBefore);
  if (!Number.isInteger(beforeWorkspaceSequence) || beforeWorkspaceSequence <= 0) {
    return {
      response: badRequest(
        "beforeWorkspaceSequence must be a positive integer when provided for activity history reads."
      )
    };
  }

  return {
    value: beforeWorkspaceSequence
  };
}

async function readAppExists(
  db: D1Database,
  input: {
    appId: string;
    workspaceId: string;
  }
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
       FROM apps
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.appId)
    .first<{ id: string }>();

  return Boolean(row);
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

  return json(
    {
      ...responseBody,
      aggregate: aggregateDescriptorForCommand(normalized.command),
      command: normalized.command
    },
    {
      status: response.status
    }
  );
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
  const hydratedCommand = await hydrateRecordMutationFieldEdits(env.DB, command);

  if (typeof hydratedCommand.workspaceId !== "string" || hydratedCommand.workspaceId.length === 0) {
    return {
      response: badRequest("workspaceId is required in the command body.")
    };
  }

  if (hydratedCommand.scope === "table" && typeof hydratedCommand.tableId !== "string") {
    return {
      response: badRequest("tableId could not be resolved for this table route.")
    };
  }

  if (
    typeof hydratedCommand.permissionsVersion !== "undefined" &&
    (typeof hydratedCommand.permissionsVersion !== "number" ||
      Number.isNaN(hydratedCommand.permissionsVersion))
  ) {
    return {
      response: badRequest(
        "permissionsVersion must be a finite number when provided for command ingress."
      )
    };
  }

  if (
    typeof hydratedCommand.permissionScopeHash !== "undefined" &&
    typeof hydratedCommand.permissionScopeHash !== "string"
  ) {
    return {
      response: badRequest("permissionScopeHash must be a string when provided for command ingress.")
    };
  }

  const explicitActorPrincipalId = readNonEmptyString(hydratedCommand.actor?.principalId);
  const actorMode = hydratedCommand.actor?.mode ?? "user";
  let actorPrincipalId = explicitActorPrincipalId;
  if (!actorPrincipalId && actorMode === "user") {
    const sessionPrincipal = await resolveSessionPrincipalForWorkspace(
      request,
      env,
      hydratedCommand.workspaceId
    );
    if ("response" in sessionPrincipal) {
      return {
        response: sessionPrincipal.response
      };
    }

    actorPrincipalId = sessionPrincipal.principalId;
  }

  if (!actorPrincipalId || (actorMode !== "user" && actorMode !== "workflow" && actorMode !== "agent")) {
    return {
      response: badRequest("actor.principalId and actor.mode are required for command ingress.")
    };
  }

  const membershipResponse = await enforceActiveUserWorkspaceMembership(env.DB, {
    principalId: actorPrincipalId,
    workspaceId: hydratedCommand.workspaceId,
    mode: actorMode
  });
  if (membershipResponse) {
    return {
      response: membershipResponse
    };
  }

  const resolvedPermissionScope = await resolveCommandPermissionScope(env.DB, hydratedCommand);
  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    permissionScopeHash:
      typeof hydratedCommand.permissionScopeHash === "string"
        ? hydratedCommand.permissionScopeHash
        : undefined,
    policyRevision:
      typeof hydratedCommand.permissionsVersion === "number"
        ? hydratedCommand.permissionsVersion
        : undefined,
    principalId: actorPrincipalId,
    scope: resolvedPermissionScope,
    workspaceId: hydratedCommand.workspaceId
  });

  if (!resolvedSnapshot.ok) {
    return {
      response: badRequest(resolvedSnapshot.message)
    };
  }

  const manualInvocationId =
    hydratedCommand.commandType === "workflow.manual"
      ? readNonEmptyString(hydratedCommand.payload?.manualInvocationId) ??
        readNonEmptyString(hydratedCommand.idempotencyKey)
      : null;

  const normalizedCommand: CommandEnvelope = {
    ...(hydratedCommand as CommandEnvelope),
    actor: {
      mode: actorMode,
      principalId: actorPrincipalId
    },
    payload:
      hydratedCommand.commandType === "workflow.manual"
        ? {
            ...((hydratedCommand.payload ?? {}) as Record<string, unknown>),
            input:
              isRecord(hydratedCommand.payload) && isRecord(hydratedCommand.payload.input)
                ? hydratedCommand.payload.input
                : {},
            manualInvocationId
          }
        : (hydratedCommand.payload as Record<string, unknown>),
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

async function handleGroupedViewMove(
  request: Request,
  env: CloudTableEnv,
  runtime: ReturnType<typeof createRuntime>,
  input: {
    body: Record<string, unknown>;
    recordId: string;
    tableId: string;
    viewId: string;
  }
): Promise<Response> {
  const workspaceId = readNonEmptyString(input.body.workspaceId);
  if (!workspaceId) {
    return badRequest("workspaceId is required in the command body.");
  }

  const permissionsVersion =
    typeof input.body.permissionsVersion === "number" &&
    Number.isFinite(input.body.permissionsVersion)
      ? input.body.permissionsVersion
      : null;
  if (input.body.permissionsVersion !== undefined && permissionsVersion === null) {
    return badRequest(
      "permissionsVersion must be a finite number when provided for grouped view moves."
    );
  }

  const permissionScopeHash =
    input.body.permissionScopeHash === undefined
      ? null
      : readNonEmptyString(input.body.permissionScopeHash);
  if (input.body.permissionScopeHash !== undefined && permissionScopeHash === null) {
    return badRequest("permissionScopeHash must be a string when provided for grouped view moves.");
  }

  const actorPrincipalId = readNonEmptyString((input.body.actor as { principalId?: unknown })?.principalId);
  const actorMode = (input.body.actor as { mode?: unknown })?.mode;
  if (
    !actorPrincipalId ||
    (actorMode !== "user" && actorMode !== "workflow" && actorMode !== "agent")
  ) {
    return badRequest("actor.principalId and actor.mode are required for grouped view moves.");
  }

  const commandId = readNonEmptyString(input.body.commandId);
  const idempotencyKey = readNonEmptyString(input.body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return badRequest("commandId and idempotencyKey are required for grouped view moves.");
  }

  const payload = isRecord(input.body.payload) ? input.body.payload : {};
  const hasTargetGroupValue =
    Object.prototype.hasOwnProperty.call(payload, "targetGroupValue") ||
    Object.prototype.hasOwnProperty.call(payload, "value");
  if (!hasTargetGroupValue) {
    return badRequest("payload.targetGroupValue is required for grouped view moves.");
  }
  const targetGroupValue = Object.prototype.hasOwnProperty.call(payload, "targetGroupValue")
    ? payload.targetGroupValue
    : payload.value;

  const resolvedViewSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    permissionScopeHash: permissionScopeHash ?? undefined,
    policyRevision: permissionsVersion ?? undefined,
    principalId: actorPrincipalId,
    scope: {
      kind: "view",
      tableId: input.tableId,
      viewId: input.viewId
    },
    workspaceId
  });
  if (!resolvedViewSnapshot.ok) {
    return badRequest(resolvedViewSnapshot.message);
  }

  const [table, viewDefinition, viewQuery] = await Promise.all([
    readTableSchemaMetadata(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        tableId: input.tableId,
        workspaceId
      }
    ),
    readViewDefinitionMetadata(env.DB, {
      tableId: input.tableId,
      viewId: input.viewId,
      workspaceId
    }),
    readViewQuery(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        snapshot: resolvedViewSnapshot.snapshot,
        tableId: input.tableId,
        viewId: input.viewId,
        workspaceId
      }
    )
  ]);
  if (!table || !viewDefinition || !viewQuery) {
    return notFound(`View ${input.viewId} was not found in table ${input.tableId}.`);
  }

  const groupMove = viewQuery.view.actions?.groupMove;
  if (!groupMove || groupMove.status !== "writable" || !groupMove.fieldId) {
    return forbidden(
      `Principal ${actorPrincipalId} is not allowed to move grouped records in view ${input.viewId}.`,
      {
        action: groupMove ?? null,
        tableId: input.tableId,
        viewId: input.viewId
      }
    );
  }

  const currentGroups = viewQuery.groups ?? [];
  const currentMembership = currentGroups.find((group) =>
    group.rows.some((row) => row.recordId === input.recordId)
  );
  if (!currentMembership) {
    return conflict(
      `Record ${input.recordId} is not currently visible in grouped view ${input.viewId}.`,
      {
        recordId: input.recordId,
        reason: "view_record_not_in_scope",
        tableId: input.tableId,
        viewId: input.viewId
      }
    );
  }

  const groupingFilters = viewDefinition.definition.filters.filter(
    (filter) => filter.fieldId === groupMove.fieldId
  );
  const blockedFilters = groupingFilters
    .filter(
      (filter) => !evaluateViewFilterForValue(runtime.workflowOperatorRegistry, filter, targetGroupValue)
    )
    .map((filter) => filter.fieldId);
  if (blockedFilters.length > 0) {
    return conflict(
      `Grouped move would remove record ${input.recordId} from view ${input.viewId}.`,
      {
        blockedFieldIds: blockedFilters,
        reason: "view_group_move_filter_mismatch",
        recordId: input.recordId,
        tableId: input.tableId,
        targetGroupValue,
        viewId: input.viewId
      }
    );
  }

  const groupField = table.fields.find((field) => field.fieldId === groupMove.fieldId);
  if (!groupField) {
    return conflict(`Grouping field ${groupMove.fieldId} could not be resolved for view ${input.viewId}.`, {
      fieldId: groupMove.fieldId,
      reason: "view_group_field_missing",
      tableId: input.tableId,
      viewId: input.viewId
    });
  }

  const resolvedTableSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    principalId: actorPrincipalId,
    scope: {
      kind: "table",
      tableId: input.tableId
    },
    workspaceId
  });
  if (!resolvedTableSnapshot.ok) {
    return badRequest(resolvedTableSnapshot.message);
  }

  const command: CommandEnvelope = {
    actor: {
      mode: actorMode,
      principalId: actorPrincipalId
    },
    commandId,
    commandType: "cell.set",
    idempotencyKey,
    payload: {
      fieldId: groupField.fieldId,
      fieldType: groupField.fieldType,
      recordId: input.recordId,
      value: targetGroupValue
    },
    permissionScopeHash: resolvedTableSnapshot.snapshot.scopeHash,
    permissionsVersion: resolvedTableSnapshot.snapshot.policyRevision,
    schemaEpoch:
      typeof input.body.schemaEpoch === "number"
        ? input.body.schemaEpoch
        : resolvedTableSnapshot.snapshot.schemaEpoch,
    scope: "table",
    tableId: input.tableId,
    workspaceId
  };

  const response = await dispatchCommandToCoordinator(env, new URL(request.url).origin, command);
  const responseBody = (await response.json()) as Record<string, unknown>;
  return json(
    {
      ...responseBody,
      aggregate: aggregateDescriptorForCommand(command),
      viewAction: {
        fieldId: groupField.fieldId,
        recordId: input.recordId,
        sourceBucketKey: currentMembership.bucketKey,
        targetGroupValue,
        type: "groupMove",
        viewId: input.viewId
      }
    },
    {
      status: response.status
    }
  );
}

function canonicalizeRecordCells(
  fields: Array<{
    fieldId: string;
    fieldKey: string;
  }>,
  cells: Record<string, unknown>
): {
  diagnostics: string[];
  cells: Record<string, unknown>;
} {
  const diagnostics = new Set<string>();
  const canonical = new Map<string, unknown>();
  const aliases = new Map<string, string>();
  for (const field of fields) {
    aliases.set(field.fieldId, field.fieldId);
    aliases.set(field.fieldKey, field.fieldId);
  }

  for (const [key, value] of Object.entries(cells)) {
    const fieldId = aliases.get(key) ?? key;
    if (canonical.has(fieldId) && JSON.stringify(canonical.get(fieldId)) !== JSON.stringify(value)) {
      diagnostics.add(`view_create_duplicate_cell:${fieldId}`);
      continue;
    }
    canonical.set(fieldId, value);
  }

  return {
    diagnostics: Array.from(diagnostics),
    cells: Object.fromEntries(canonical)
  };
}

function resolveViewCreateDefaults(
  workflowOperatorRegistry: ReturnType<typeof createRuntime>["workflowOperatorRegistry"],
  table: NonNullable<Awaited<ReturnType<typeof readTableSchemaMetadata>>>,
  viewDefinition: NonNullable<Awaited<ReturnType<typeof readViewDefinitionMetadata>>>,
  targetGroupValue: unknown
): {
  ok: true;
  defaultCells: Record<string, JsonValue>;
} | {
  message: string;
  ok: false;
  reason: string;
} {
  const defaults = new Map<string, JsonValue>();
  const setDefault = (fieldId: string, value: JsonValue) => {
    if (!defaults.has(fieldId)) {
      defaults.set(fieldId, value);
      return true;
    }
    return JSON.stringify(defaults.get(fieldId)) === JSON.stringify(value);
  };

  if (viewDefinition.definition.groupByFieldId) {
    if (targetGroupValue === undefined) {
      return {
        message: "payload.targetGroupValue is required for grouped view record creation.",
        ok: false,
        reason: "view_group_value_required"
      };
    }

    if (!setDefault(viewDefinition.definition.groupByFieldId, (targetGroupValue ?? null) as JsonValue)) {
      return {
        message: `Grouped view ${viewDefinition.viewId} has conflicting group defaults.`,
        ok: false,
        reason: "view_create_conflicting_group_defaults"
      };
    }
  }

  for (const filter of viewDefinition.definition.filters) {
    let filterValue: JsonValue;
    switch (filter.operatorId) {
      case "equals":
        filterValue = (filter.value ?? null) as JsonValue;
        break;
      case "is_empty":
        filterValue = null;
        break;
      default:
        return {
          message: `View ${viewDefinition.viewId} cannot create records through filter ${filter.fieldId}.`,
          ok: false,
          reason: "view_create_filter_unsupported"
        };
    }

    if (!setDefault(filter.fieldId, filterValue)) {
      return {
        message: `View ${viewDefinition.viewId} has conflicting filter defaults for ${filter.fieldId}.`,
        ok: false,
        reason: "view_create_conflicting_filter_defaults"
      };
    }
  }

  for (const filter of viewDefinition.definition.filters) {
    const value = defaults.get(filter.fieldId) ?? null;
    if (!evaluateViewFilterForValue(workflowOperatorRegistry, filter, value)) {
      return {
        message: `View-scoped create would violate filter ${filter.fieldId} in ${viewDefinition.viewId}.`,
        ok: false,
        reason: "view_create_filter_mismatch"
      };
    }
  }

  const missingFieldIds = Array.from(defaults.keys()).filter(
    (fieldId) => !table.fields.some((field) => field.fieldId === fieldId)
  );
  if (missingFieldIds.length > 0) {
    return {
      message: `View ${viewDefinition.viewId} references unknown create fields: ${missingFieldIds.join(", ")}.`,
      ok: false,
      reason: "view_create_field_missing"
    };
  }

  return {
    defaultCells: Object.fromEntries(defaults),
    ok: true
  };
}

async function prepareViewScopedCreateInput(
  env: CloudTableEnv,
  runtime: ReturnType<typeof createRuntime>,
  snapshot: EffectivePermissionSnapshot,
  input: Record<string, unknown>
): Promise<
  | {
      ok: true;
      diagnostics: string[];
      sanitized: Record<string, unknown>;
    }
  | {
      message: string;
      ok: false;
      status: number;
    }
> {
  const tableId = readNonEmptyString(input.tableId);
  const viewId = readNonEmptyString(input.viewId);
  const recordId = readNonEmptyString(input.recordId);
  if (!tableId || !viewId || !recordId) {
    return {
      message: "tableId, viewId, and recordId are required for view-scoped createRecord preview.",
      ok: false,
      status: 400
    };
  }

  const [table, viewDefinition, viewQuery] = await Promise.all([
    readTableSchemaMetadata(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        tableId,
        workspaceId: snapshot.workspaceId
      }
    ),
    readViewDefinitionMetadata(env.DB, {
      tableId,
      viewId,
      workspaceId: snapshot.workspaceId
    }),
    readViewQuery(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        snapshot,
        tableId,
        viewId,
        workspaceId: snapshot.workspaceId
      }
    )
  ]);
  if (!table || !viewDefinition || !viewQuery) {
    return {
      message: `View ${viewId} was not found in table ${tableId}.`,
      ok: false,
      status: 404
    };
  }

  const createRecord = viewQuery.view.actions?.createRecord;
  if (!createRecord || createRecord.status !== "writable") {
    return {
      message: `Principal ${snapshot.principalId} is not allowed to create records in view ${viewId}.`,
      ok: false,
      status: 403
    };
  }

  const rawCells = readOptionalAgentToolObject(input.cells) ?? {};
  const hasTargetGroupValue =
    Object.prototype.hasOwnProperty.call(input, "targetGroupValue") ||
    Object.prototype.hasOwnProperty.call(input, "groupValue") ||
    Object.prototype.hasOwnProperty.call(input, "value");
  const targetGroupValue = Object.prototype.hasOwnProperty.call(input, "targetGroupValue")
    ? input.targetGroupValue
    : Object.prototype.hasOwnProperty.call(input, "groupValue")
      ? input.groupValue
      : Object.prototype.hasOwnProperty.call(input, "value")
        ? input.value
        : undefined;

  const defaultPlan = resolveViewCreateDefaults(
    runtime.workflowOperatorRegistry,
    table,
    viewDefinition,
    hasTargetGroupValue ? targetGroupValue : undefined
  );
  if (!defaultPlan.ok) {
    return {
      message: defaultPlan.message,
      ok: false,
      status: defaultPlan.reason === "view_group_value_required" ? 400 : 409
    };
  }

  const canonicalized = canonicalizeRecordCells(table.fields, rawCells);
  if (canonicalized.diagnostics.length > 0) {
    return {
      message: `View-scoped create preview received conflicting cell aliases for ${recordId}.`,
      ok: false,
      status: 409
    };
  }

  for (const [fieldId, value] of Object.entries(defaultPlan.defaultCells)) {
    if (
      Object.prototype.hasOwnProperty.call(canonicalized.cells, fieldId) &&
      JSON.stringify(canonicalized.cells[fieldId]) !== JSON.stringify(value)
    ) {
      return {
        message: `View-scoped create preview would violate field constraint ${fieldId}.`,
        ok: false,
        status: 409
      };
    }
  }

  return {
    diagnostics: canonicalized.diagnostics,
    ok: true,
    sanitized: {
      ...input,
      cells: {
        ...canonicalized.cells,
        ...defaultPlan.defaultCells
      }
    }
  };
}

async function handleViewScopedRecordCreate(
  request: Request,
  env: CloudTableEnv,
  runtime: ReturnType<typeof createRuntime>,
  input: {
    body: Record<string, unknown>;
    tableId: string;
    viewId: string;
  }
): Promise<Response> {
  const workspaceId = readNonEmptyString(input.body.workspaceId);
  if (!workspaceId) {
    return badRequest("workspaceId is required in the command body.");
  }

  const permissionsVersion =
    typeof input.body.permissionsVersion === "number" &&
    Number.isFinite(input.body.permissionsVersion)
      ? input.body.permissionsVersion
      : null;
  if (input.body.permissionsVersion !== undefined && permissionsVersion === null) {
    return badRequest(
      "permissionsVersion must be a finite number when provided for view-scoped record creation."
    );
  }

  const permissionScopeHash =
    input.body.permissionScopeHash === undefined
      ? null
      : readNonEmptyString(input.body.permissionScopeHash);
  if (input.body.permissionScopeHash !== undefined && permissionScopeHash === null) {
    return badRequest(
      "permissionScopeHash must be a string when provided for view-scoped record creation."
    );
  }

  const actorPrincipalId = readNonEmptyString((input.body.actor as { principalId?: unknown })?.principalId);
  const actorMode = (input.body.actor as { mode?: unknown })?.mode;
  if (
    !actorPrincipalId ||
    (actorMode !== "user" && actorMode !== "workflow" && actorMode !== "agent")
  ) {
    return badRequest(
      "actor.principalId and actor.mode are required for view-scoped record creation."
    );
  }

  const commandId = readNonEmptyString(input.body.commandId);
  const idempotencyKey = readNonEmptyString(input.body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return badRequest(
      "commandId and idempotencyKey are required for view-scoped record creation."
    );
  }

  const payload = isRecord(input.body.payload) ? input.body.payload : {};
  const recordId = readNonEmptyString(payload.recordId);
  if (!recordId) {
    return badRequest("payload.recordId is required for view-scoped record creation.");
  }

  const rawCells =
    typeof payload.cells === "object" && payload.cells !== null && !Array.isArray(payload.cells)
      ? (payload.cells as Record<string, unknown>)
      : {};
  const hasTargetGroupValue =
    Object.prototype.hasOwnProperty.call(payload, "targetGroupValue") ||
    Object.prototype.hasOwnProperty.call(payload, "groupValue") ||
    Object.prototype.hasOwnProperty.call(payload, "value");
  const targetGroupValue = Object.prototype.hasOwnProperty.call(payload, "targetGroupValue")
    ? payload.targetGroupValue
    : Object.prototype.hasOwnProperty.call(payload, "groupValue")
      ? payload.groupValue
      : Object.prototype.hasOwnProperty.call(payload, "value")
        ? payload.value
        : undefined;

  const resolvedViewSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    permissionScopeHash: permissionScopeHash ?? undefined,
    policyRevision: permissionsVersion ?? undefined,
    principalId: actorPrincipalId,
    scope: {
      kind: "view",
      tableId: input.tableId,
      viewId: input.viewId
    },
    workspaceId
  });
  if (!resolvedViewSnapshot.ok) {
    return badRequest(resolvedViewSnapshot.message);
  }

  const [table, viewDefinition, viewQuery] = await Promise.all([
    readTableSchemaMetadata(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        tableId: input.tableId,
        workspaceId
      }
    ),
    readViewDefinitionMetadata(env.DB, {
      tableId: input.tableId,
      viewId: input.viewId,
      workspaceId
    }),
    readViewQuery(
      env.DB,
      runtime.fieldTypeRegistry,
      runtime.viewPlanner,
      runtime.workflowOperatorRegistry,
      {
        snapshot: resolvedViewSnapshot.snapshot,
        tableId: input.tableId,
        viewId: input.viewId,
        workspaceId
      }
    )
  ]);
  if (!table || !viewDefinition || !viewQuery) {
    return notFound(`View ${input.viewId} was not found in table ${input.tableId}.`);
  }

  const createRecord = viewQuery.view.actions?.createRecord;
  if (!createRecord || createRecord.status !== "writable") {
    return forbidden(
      `Principal ${actorPrincipalId} is not allowed to create records in view ${input.viewId}.`,
      {
        action: createRecord ?? null,
        tableId: input.tableId,
        viewId: input.viewId
      }
    );
  }

  const defaultPlan = resolveViewCreateDefaults(
    runtime.workflowOperatorRegistry,
    table,
    viewDefinition,
    hasTargetGroupValue ? targetGroupValue : undefined
  );
  if (!defaultPlan.ok) {
    const status = defaultPlan.reason === "view_group_value_required" ? 400 : 409;
    return json(
      {
        details: {
          reason: defaultPlan.reason,
          tableId: input.tableId,
          viewId: input.viewId
        },
        error: status === 400 ? "bad_request" : "conflict",
        message: defaultPlan.message
      },
      {
        status
      }
    );
  }

  const canonicalized = canonicalizeRecordCells(table.fields, rawCells);
  if (canonicalized.diagnostics.length > 0) {
    return conflict(`View-scoped create received conflicting cell aliases for ${recordId}.`, {
      diagnostics: canonicalized.diagnostics,
      reason: "view_create_duplicate_cell_alias",
      recordId,
      tableId: input.tableId,
      viewId: input.viewId
    });
  }

  for (const [fieldId, value] of Object.entries(defaultPlan.defaultCells)) {
    if (
      Object.prototype.hasOwnProperty.call(canonicalized.cells, fieldId) &&
      JSON.stringify(canonicalized.cells[fieldId]) !== JSON.stringify(value)
    ) {
      return conflict(`View-scoped create would violate field constraint ${fieldId}.`, {
        fieldId,
        providedValue: canonicalized.cells[fieldId],
        reason: "view_create_constraint_mismatch",
        requiredValue: value,
        tableId: input.tableId,
        viewId: input.viewId
      });
    }
  }

  const cells = {
    ...canonicalized.cells,
    ...defaultPlan.defaultCells
  };

  const resolvedTableSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    principalId: actorPrincipalId,
    scope: {
      kind: "table",
      tableId: input.tableId
    },
    workspaceId
  });
  if (!resolvedTableSnapshot.ok) {
    return badRequest(resolvedTableSnapshot.message);
  }

  const command: CommandEnvelope = {
    actor: {
      mode: actorMode,
      principalId: actorPrincipalId
    },
    commandId,
    commandType: "record.create",
    idempotencyKey,
    payload: {
      ...(typeof payload.recordKey === "string" && payload.recordKey.length > 0
        ? { recordKey: payload.recordKey }
        : {}),
      cells,
      recordId
    },
    permissionScopeHash: resolvedTableSnapshot.snapshot.scopeHash,
    permissionsVersion: resolvedTableSnapshot.snapshot.policyRevision,
    schemaEpoch:
      typeof input.body.schemaEpoch === "number"
        ? input.body.schemaEpoch
        : resolvedTableSnapshot.snapshot.schemaEpoch,
    scope: "table",
    tableId: input.tableId,
    workspaceId
  };

  const response = await dispatchCommandToCoordinator(env, new URL(request.url).origin, command);
  const responseBody = (await response.json()) as Record<string, unknown>;
  return json(
    {
      ...responseBody,
      aggregate: aggregateDescriptorForCommand(command),
      viewAction: {
        defaultedFieldIds: Object.keys(defaultPlan.defaultCells),
        recordId,
        targetGroupValue: hasTargetGroupValue ? targetGroupValue ?? null : null,
        type: "createRecord",
        viewId: input.viewId
      }
    },
    {
      status: response.status
    }
  );
}

function evaluateViewFilterForValue(
  workflowOperatorRegistry: ReturnType<typeof createWorkflowOperatorRegistry>,
  filter: {
    comparator?: string;
    fieldId: string;
    operatorId: string;
    value?: unknown;
  },
  value: unknown
): boolean {
  const operator = workflowOperatorRegistry.get(filter.operatorId);
  if (!operator || operator.kind !== "condition") {
    return false;
  }

  switch (filter.operatorId) {
    case "equals":
    case "not_equals":
      return operator.evaluate({
        left: value,
        right: filter.value
      });
    case "is_empty":
    case "is_not_empty":
      return operator.evaluate({
        value
      });
    case "text_contains":
      return operator.evaluate({
        query: filter.value,
        value
      });
    case "text_starts_with":
      return operator.evaluate({
        prefix: filter.value,
        value
      });
    case "number_compare":
    case "date_compare":
      return operator.evaluate({
        comparator: filter.comparator,
        left: value,
        right: filter.value
      });
    case "select_has_option":
      return operator.evaluate({
        option: filter.value,
        value
      });
    case "relation_contains_record":
      return operator.evaluate({
        recordId: filter.value,
        value
      });
    default:
      return false;
  }
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
    case "explainPermissions": {
      const fieldId = readRequiredAgentToolString(input.fieldId, "fieldId");
      return {
        input: {
          fieldId,
          fieldType:
            readOptionalAgentToolString(input.fieldType) ??
            context.snapshot.fields[fieldId]?.fieldType,
          recordId: readOptionalAgentToolString(input.recordId) ?? undefined,
          surfaces: readExplainablePermissionSurfaces(input.surfaces),
          tableId: readOptionalAgentToolString(input.tableId) ?? undefined,
          viewId: readOptionalAgentToolString(input.viewId) ?? undefined,
          workspaceId: context.workspaceId
        } as ExplainPermissionsToolInput,
        toolId
      };
    }
    case "previewPermissionPersona":
      return {
        input: {
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          viewId: readRequiredAgentToolString(input.viewId, "viewId"),
          workspaceId: context.workspaceId
        },
        toolId
      };
    case "inspectRecord":
      return {
        input: {
          recordId: readRequiredAgentToolString(input.recordId, "recordId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workspaceId: context.workspaceId
        } as InspectRecordToolInput,
        toolId
      };
    case "queryView":
      return {
        input: {
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          viewId: readRequiredAgentToolString(input.viewId, "viewId"),
          workspaceId: context.workspaceId
        } as QueryViewToolInput,
        toolId
      };
    case "readActivityHistory":
      return {
        input: {
          beforeTableSequence:
            typeof input.beforeTableSequence === "number"
              ? readPositiveInteger(input.beforeTableSequence, "beforeTableSequence")
              : undefined,
          limit:
            typeof input.limit === "number" ? readActivityHistoryLimit(input.limit) : undefined,
          recordId: readOptionalAgentToolString(input.recordId) ?? undefined,
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workspaceId: context.workspaceId
        } as ReadActivityHistoryToolInput,
        toolId
      };
    case "readWorkspaceActivityHistory":
      return {
        input: {
          beforeWorkspaceSequence:
            typeof input.beforeWorkspaceSequence === "number"
              ? readPositiveInteger(input.beforeWorkspaceSequence, "beforeWorkspaceSequence")
              : undefined,
          limit:
            typeof input.limit === "number" ? readActivityHistoryLimit(input.limit) : undefined,
          workspaceId: context.workspaceId
        } as ReadWorkspaceActivityHistoryToolInput,
        toolId
      };
    case "inspectApp":
      return {
        input: {
          appId: readRequiredAgentToolString(input.appId, "appId"),
          workspaceId: context.workspaceId
        } as InspectAppToolInput,
        toolId
      };
    case "inspectTableSchema":
      return {
        input: {
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workspaceId: context.workspaceId
        } as InspectTableSchemaToolInput,
        toolId
      };
    case "inspectViewDefinition":
      return {
        input: {
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          viewId: readRequiredAgentToolString(input.viewId, "viewId"),
          workspaceId: context.workspaceId
        } as InspectViewDefinitionToolInput,
        toolId
      };
    case "inspectWorkflowDefinition":
      return {
        input: {
          workflowId: readRequiredAgentToolString(input.workflowId, "workflowId"),
          workspaceId: context.workspaceId
        } as InspectWorkflowDefinitionToolInput,
        toolId
      };
    case "readAppActivityHistory":
      return {
        input: {
          appId: readRequiredAgentToolString(input.appId, "appId"),
          beforeWorkspaceSequence:
            typeof input.beforeWorkspaceSequence === "number"
              ? readPositiveInteger(input.beforeWorkspaceSequence, "beforeWorkspaceSequence")
              : undefined,
          limit:
            typeof input.limit === "number" ? readActivityHistoryLimit(input.limit) : undefined,
          workspaceId: context.workspaceId
        } as ReadAppActivityHistoryToolInput,
        toolId
      };
    case "readWorkflowHistory":
      return {
        input: {
          workflowId: readRequiredAgentToolString(input.workflowId, "workflowId"),
          workspaceId: context.workspaceId
        } as ReadWorkflowHistoryToolInput,
        toolId
      };
    case "readWorkflowRunDetail":
      return {
        input: {
          workflowRunId: readRequiredAgentToolString(input.workflowRunId, "workflowRunId"),
          workspaceId: context.workspaceId
        } as ReadWorkflowRunDetailToolInput,
        toolId
      };
    case "prepareWorkflowDeadLetterReplay":
      return {
        input: {
          ...commandContext,
          deadLetterId: readRequiredAgentToolString(input.deadLetterId, "deadLetterId"),
          replayRequestId: readOptionalAgentToolString(input.replayRequestId) ?? undefined
        } as WorkflowDeadLetterReplayToolInput,
        toolId
      };
    case "requestWorkflowDeadLetterReplay":
      if (ingress !== "execute") {
        throw new Error("Execution-phase agent tools are not allowed on the preview ingress.");
      }
      return {
        input: {
          ...commandContext,
          deadLetterId: readRequiredAgentToolString(input.deadLetterId, "deadLetterId"),
          replayRequestId: readOptionalAgentToolString(input.replayRequestId) ?? undefined
        } as WorkflowDeadLetterReplayToolInput,
        toolId
      };
    case "createApp":
      return {
        input: {
          ...commandContext,
          appId: readRequiredAgentToolString(input.appId, "appId"),
          appName: readRequiredAgentToolString(input.appName, "appName"),
          appSlug: readRequiredAgentToolString(input.appSlug, "appSlug")
        } as CreateAppToolInput,
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
    case "deleteView":
      return {
        input: {
          ...commandContext,
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          viewId: readRequiredAgentToolString(input.viewId, "viewId")
        } as DeleteViewToolInput,
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
    case "updateField":
      return {
        input: {
          ...commandContext,
          config: readRequiredAgentToolObject(input.config, "config"),
          fieldId: readRequiredAgentToolString(input.fieldId, "fieldId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId")
        } as UpdateFieldToolInput,
        toolId
      };
    case "archiveField":
      return {
        input: {
          ...commandContext,
          fieldId: readRequiredAgentToolString(input.fieldId, "fieldId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId")
        } as ArchiveFieldToolInput,
        toolId
      };
    case "reorderFields":
      return {
        input: {
          ...commandContext,
          fieldIds: readRequiredAgentToolStringArray(input.fieldIds, "fieldIds"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId")
        } as ReorderFieldsToolInput,
        toolId
      };
    case "createRecord":
      return {
        input: {
          ...commandContext,
          cells: readOptionalAgentToolObject(input.cells) ?? undefined,
          recordId: readRequiredAgentToolString(input.recordId, "recordId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId")
        } as CreateRecordToolInput,
        toolId
      };
    case "updateRecord":
      if (!Object.prototype.hasOwnProperty.call(input, "patch")) {
        throw new Error("patch is required for this agent tool.");
      }
      return {
        input: {
          ...commandContext,
          patch: readRequiredAgentToolObject(input.patch, "patch"),
          recordId: readRequiredAgentToolString(input.recordId, "recordId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId")
        } as UpdateRecordToolInput,
        toolId
      };
    case "bulkUpdateRecords": {
      const updates = readBulkRecordUpdates(input.updates);
      return {
        input: {
          ...commandContext,
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          updates
        } as BulkUpdateRecordsToolInput,
        toolId
      };
    }
    case "archiveRecord":
      return {
        input: {
          ...commandContext,
          recordId: readRequiredAgentToolString(input.recordId, "recordId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId")
        } as ArchiveRecordToolInput,
        toolId
      };
    case "updateCell":
      if (!Object.prototype.hasOwnProperty.call(input, "value")) {
        throw new Error("value is required for this agent tool.");
      }
      return {
        input: {
          ...commandContext,
          fieldId: readRequiredAgentToolString(input.fieldId, "fieldId"),
          recordId: readRequiredAgentToolString(input.recordId, "recordId"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          value: input.value
        } as UpdateCellToolInput,
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
    case "updateWorkflow":
      return {
        input: {
          ...commandContext,
          definition: isRecord(input.definition) ? input.definition : {},
          name: readRequiredAgentToolString(input.name, "name"),
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workflowId: readRequiredAgentToolString(input.workflowId, "workflowId")
        } as UpdateWorkflowToolInput,
        toolId
      };
    case "publishWorkflow":
      return {
        input: {
          ...commandContext,
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workflowId: readRequiredAgentToolString(input.workflowId, "workflowId")
        } as PublishWorkflowToolInput,
        toolId
      };
    case "pauseWorkflow":
      return {
        input: {
          ...commandContext,
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workflowId: readRequiredAgentToolString(input.workflowId, "workflowId")
        } as PauseWorkflowToolInput,
        toolId
      };
    case "runWorkflow":
      return {
        input: {
          ...commandContext,
          input: readOptionalAgentToolObject(input.input) ?? undefined,
          manualInvocationId: readOptionalAgentToolString(input.manualInvocationId) ?? undefined,
          tableId: readRequiredAgentToolString(input.tableId, "tableId"),
          workflowId: readRequiredAgentToolString(input.workflowId, "workflowId")
        } as RunWorkflowToolInput,
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

  const unsupportedToolId: never = toolId;
  throw new Error(`Unsupported agent tool: ${unsupportedToolId}`);
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
  const workflowOperationsTool =
    toolId === "inspectWorkflowDefinition" ||
    toolId === "readWorkflowHistory" ||
    toolId === "readWorkflowRunDetail" ||
    toolId === "prepareWorkflowDeadLetterReplay" ||
    toolId === "requestWorkflowDeadLetterReplay";
  const workflowOperationsAccess = workflowOperationsTool
    ? await resolveWorkflowOperationsAccess(request, env, {
        deadLetterId:
          toolId === "prepareWorkflowDeadLetterReplay" ||
          toolId === "requestWorkflowDeadLetterReplay"
            ? readNonEmptyString(input.deadLetterId)
            : null,
        permissionScopeHash,
        policyRevisionValue: policyRevision === null ? null : String(policyRevision),
        principalId,
        workflowId:
          toolId === "inspectWorkflowDefinition" || toolId === "readWorkflowHistory"
            ? readNonEmptyString(input.workflowId)
            : null,
        workflowRunId:
          toolId === "readWorkflowRunDetail" ? readNonEmptyString(input.workflowRunId) : null,
        workspaceId
      })
    : null;
  if (workflowOperationsAccess && "response" in workflowOperationsAccess) {
    return workflowOperationsAccess.response;
  }

  const resolvedScope =
    workflowOperationsAccess === null
      ? resolveAgentToolScope(toolId as AgentToolId, workspaceId, input)
      : null;
  if (resolvedScope && !resolvedScope.ok) {
    return badRequest(resolvedScope.message);
  }

  const resolvedSnapshot =
    workflowOperationsAccess?.snapshot != null
      ? {
          ok: true as const,
          snapshot: workflowOperationsAccess.snapshot
        }
      : await resolvePermissionSnapshot(env.DB, {
          fieldTypeRegistry: runtime.fieldTypeRegistry,
          permissionScopeHash,
          policyRevision,
          principalId,
          scope: resolvedScope!.scope,
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

  let sanitizedInput = permissionedRuntime.agentToolRegistry.sanitizeInput(
    tool.id,
    input,
    fields,
    snapshot
  );
  if (tool.id === "createRecord" && readNonEmptyString(sanitizedInput.sanitized.viewId)) {
    const prepared = await prepareViewScopedCreateInput(env, runtime, snapshot, sanitizedInput.sanitized);
    if (!prepared.ok) {
      return json(
        {
          error:
            prepared.status === 403
              ? "forbidden"
              : prepared.status === 404
                ? "not_found"
                : prepared.status === 409
                  ? "conflict"
                  : "bad_request",
          message: prepared.message
        },
        {
          status: prepared.status
        }
      );
    }

    sanitizedInput = {
      ...sanitizedInput,
      diagnostics: Array.from(new Set([...sanitizedInput.diagnostics, ...prepared.diagnostics])),
      sanitized: prepared.sanitized
    };
  }

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

  let result: AgentToolInvocationResult;
  try {
    result =
      invocation.toolId === "executeCommand"
        ? await invokeReviewedExecutionTool(invocation.input.command, env, request.url)
        : invocation.toolId === "explainPermissions"
          ? explainPermissionsWithResolvedSnapshot(
              invocation.input,
              snapshot,
              permissionedRuntime.permissionEngine,
              await resolvePermissionEvaluationContext(env.DB, runtime.fieldTypeRegistry, {
                principalId,
                recordId: invocation.input.recordId,
                tableId: invocation.input.tableId,
                workspaceId
              })
            )
        : await permissionedRuntime.agentToolRegistry.invoke(invocation);
  } catch (error) {
    if (error instanceof SchemaMetadataAccessError) {
      return forbidden(error.message, error.details);
    }

    throw error;
  }
  const serializedResult = serializeAgentToolResult(result);
  const sanitizedOutput =
    tool.id === "readWorkflowHistory" ||
    tool.id === "readWorkflowRunDetail" ||
    tool.id === "prepareWorkflowDeadLetterReplay" ||
    tool.id === "requestWorkflowDeadLetterReplay"
      ? {
          diagnostics: [] as string[],
          hiddenFieldIds: [] as string[],
          sanitized: serializedResult
        }
      : permissionedRuntime.agentToolRegistry.sanitizeOutput(tool.id, serializedResult, fields, snapshot);

  const status =
    result.kind === "workflow-dead-letter-replay" && result.status === "rejected"
      ? result.reason === "not_found"
        ? 404
        : result.reason === "already_requested"
          ? 409
          : 400
      : 200;

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
  }, { status });
}

async function handlePermissionExplainIngress(
  request: Request,
  env: CloudTableEnv
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(request.method, ["POST"]);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Permission explanation body must be valid JSON.");
  }

  const workspaceId = readNonEmptyString(body.workspaceId);
  const principalId = readNonEmptyString(body.principalId);
  const tableId = readNonEmptyString(body.tableId);
  const viewId = readNonEmptyString(body.viewId);
  const recordId = readNonEmptyString(body.recordId);
  const fieldId = readNonEmptyString(body.fieldId);
  const permissionScopeHash = readNonEmptyString(body.permissionScopeHash);
  const policyRevision =
    typeof body.policyRevision === "number" && Number.isFinite(body.policyRevision)
      ? body.policyRevision
      : null;
  let surfaces: ExplainPermissionsToolInput["surfaces"];
  try {
    surfaces = readExplainablePermissionSurfaces(body.surfaces);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : "Permission explanation surfaces were invalid."
    );
  }

  if (!workspaceId || !principalId || !tableId || !fieldId) {
    return badRequest(
      "workspaceId, principalId, tableId, and fieldId are required for permission explanation ingress."
    );
  }

  if (body.policyRevision !== undefined && policyRevision === null) {
    return badRequest(
      "policyRevision must be a finite number when provided for permission explanation ingress."
    );
  }

  const runtime = createRuntime(env);
  const resolvedSnapshot = await resolvePermissionSnapshot(env.DB, {
    fieldTypeRegistry: runtime.fieldTypeRegistry,
    permissionScopeHash,
    policyRevision,
    principalId,
    scope: viewId
      ? {
          kind: "view",
          tableId,
          viewId
        }
      : {
          kind: "table",
          tableId
        },
    workspaceId
  });

  if (!resolvedSnapshot.ok) {
    return badRequest(resolvedSnapshot.message);
  }

  const result = explainPermissionsWithResolvedSnapshot(
    {
      fieldId,
      fieldType: readOptionalAgentToolString(body.fieldType) ?? undefined,
      recordId: recordId ?? undefined,
      surfaces,
      tableId,
      viewId: viewId ?? undefined,
      workspaceId
    },
    resolvedSnapshot.snapshot,
    runtime.permissionEngine,
    await resolvePermissionEvaluationContext(env.DB, runtime.fieldTypeRegistry, {
      principalId,
      recordId: recordId ?? undefined,
      tableId,
      workspaceId
    })
  );

  return json({
    explanation: result.explanation,
    permissionScope: {
      policyRevision: resolvedSnapshot.snapshot.policyRevision,
      principalId: resolvedSnapshot.snapshot.principalId,
      scopeHash: resolvedSnapshot.snapshot.scopeHash,
      workspaceId
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

async function handlePermissionExplanationIngress(
  request: Request,
  env: CloudTableEnv,
  runtime: CloudTableRuntime
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(request.method, ["POST"]);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Permission explanation body must be valid JSON.");
  }

  const workspaceId = readNonEmptyString(body.workspaceId);
  const principalId = readNonEmptyString(body.principalId);
  const recordId = readNonEmptyString(body.recordId);
  const fieldId = readNonEmptyString(body.fieldId);
  const permissionScopeHash = readNonEmptyString(body.permissionScopeHash);
  const policyRevision =
    typeof body.policyRevision === "number" && Number.isFinite(body.policyRevision)
      ? body.policyRevision
      : null;

  if (!workspaceId || !principalId || !fieldId) {
    return badRequest("workspaceId, principalId, and fieldId are required for permission explanation ingress.");
  }

  if (body.policyRevision !== undefined && policyRevision === null) {
    return badRequest(
      "policyRevision must be a finite number when provided for permission explanation ingress."
    );
  }

  if (body.permissionScopeHash !== undefined && permissionScopeHash === null) {
    return badRequest(
      "permissionScopeHash must be a string when provided for permission explanation ingress."
    );
  }

  let surfaces: ReturnType<typeof readExplainablePermissionSurfaces> | undefined;
  try {
    surfaces = readExplainablePermissionSurfaces(body.surfaces);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : "Permission explanation surfaces are invalid."
    );
  }

  const rawInput: Record<string, unknown> = {
    fieldId,
    recordId,
    surfaces,
    tableId: body.tableId,
    viewId: body.viewId
  };
  if (body.fieldType !== undefined) {
    rawInput.fieldType = body.fieldType;
  }

  const resolvedScope = resolveAgentToolScope("explainPermissions", workspaceId, rawInput);
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
  if (!snapshot.fields[fieldId]) {
    return forbidden(
      `Principal ${principalId} is not allowed to inspect permission details for field ${fieldId} in the resolved scope.`,
      {
        hiddenFieldIds: [fieldId]
      }
    );
  }

  const permissionedRuntime = createRuntimeWithSnapshot(env, snapshot);
  let invocation: AgentToolInvocation;
  try {
    invocation = buildAgentToolInvocation("explainPermissions", rawInput, "preview", {
      permissionScopeHash: snapshot.scopeHash,
      policyRevision: snapshot.policyRevision,
      principalId,
      snapshot,
      workspaceId
    });
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : "Permission explanation input was invalid."
    );
  }

  const explainInvocation = invocation as Extract<AgentToolInvocation, { toolId: "explainPermissions" }>;
  const result = explainPermissionsWithResolvedSnapshot(
    explainInvocation.input,
    snapshot,
    permissionedRuntime.permissionEngine,
    await resolvePermissionEvaluationContext(env.DB, runtime.fieldTypeRegistry, {
      principalId,
      recordId: explainInvocation.input.recordId,
      tableId: explainInvocation.input.tableId,
      workspaceId
    })
  );

  return json({
    explanation: result.explanation,
    permissionScope: {
      policyRevision: snapshot.policyRevision,
      principalId: snapshot.principalId,
      scopeHash: snapshot.scopeHash,
      workspaceId
    }
  });
}

async function handlePermissionPersonaPreviewIngress(
  request: Request,
  env: CloudTableEnv,
  runtime: CloudTableRuntime
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(request.method, ["POST"]);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Permission persona preview body must be valid JSON.");
  }

  const workspaceId = readNonEmptyString(body.workspaceId);
  const principalId = readNonEmptyString(body.principalId);
  const tableId = readNonEmptyString(body.tableId);
  const viewId = readNonEmptyString(body.viewId);
  const permissionScopeHash = readNonEmptyString(body.permissionScopeHash);
  const policyRevision =
    typeof body.policyRevision === "number" && Number.isFinite(body.policyRevision)
      ? body.policyRevision
      : null;

  if (!workspaceId || !principalId || !tableId || !viewId) {
    return badRequest(
      "workspaceId, principalId, tableId, and viewId are required for permission persona preview ingress."
    );
  }

  if (body.policyRevision !== undefined && policyRevision === null) {
    return badRequest(
      "policyRevision must be a finite number when provided for permission persona preview ingress."
    );
  }

  if (body.permissionScopeHash !== undefined && permissionScopeHash === null) {
    return badRequest(
      "permissionScopeHash must be a string when provided for permission persona preview ingress."
    );
  }

  const rawInput: Record<string, unknown> = {
    tableId,
    viewId
  };
  const resolvedScope = resolveAgentToolScope("previewPermissionPersona", workspaceId, rawInput);
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
  let invocation: AgentToolInvocation;
  try {
    invocation = buildAgentToolInvocation("previewPermissionPersona", rawInput, "preview", {
      permissionScopeHash: snapshot.scopeHash,
      policyRevision: snapshot.policyRevision,
      principalId,
      snapshot,
      workspaceId
    });
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : "Permission persona preview input was invalid."
    );
  }

  const result = await permissionedRuntime.agentToolRegistry.invoke(invocation);
  if (result.kind !== "permission-persona-preview") {
    throw new Error("Permission persona preview ingress returned an unexpected agent tool result.");
  }

  return json({
    permissionScope: {
      policyRevision: snapshot.policyRevision,
      principalId: snapshot.principalId,
      scopeHash: snapshot.scopeHash,
      workspaceId
    },
    preview: result.preview
  });
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

async function hydrateRecordMutationFieldEdits(
  db: D1Database,
  command: Partial<CommandEnvelope>
): Promise<Partial<CommandEnvelope>> {
  if (command.commandType !== "records.bulk_patch" || typeof command.tableId !== "string") {
    return command;
  }

  const payload = isRecord(command.payload) ? command.payload : {};
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (updates.length === 0) {
    return command;
  }

  const fieldRows = await db
    .prepare(
      `SELECT id, field_key, field_type
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
    )
    .bind(command.workspaceId ?? "", command.tableId)
    .all<{ field_key: string; field_type: string; id: string }>();
  const fieldsByIdentifier = new Map<string, { fieldId: string; fieldType: string }>();
  for (const field of fieldRows.results ?? []) {
    fieldsByIdentifier.set(field.id, {
      fieldId: field.id,
      fieldType: field.field_type
    });
    fieldsByIdentifier.set(field.field_key, {
      fieldId: field.id,
      fieldType: field.field_type
    });
  }

  const fieldEdits = updates.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.patch)) {
      return [];
    }
    const patch = entry.patch;

    return Object.keys(patch)
      .sort()
      .flatMap((patchKey) => {
        const field = fieldsByIdentifier.get(patchKey);
        return field
          ? [
              {
                fieldId: field.fieldId,
                fieldType: field.fieldType,
                value: patch[patchKey]
              }
            ]
          : [];
      });
  });

  return {
    ...command,
    payload: {
      ...payload,
      fieldEdits
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRequiredAgentToolString(value: unknown, key: string): string {
  const parsed = readNonEmptyString(value);
  if (!parsed) {
    throw new Error(`${key} is required for this agent tool.`);
  }

  return parsed;
}

function readOptionalAgentToolString(value: unknown): string | null {
  return readNonEmptyString(value);
}

function readRequiredAgentToolStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array for this agent tool.`);
  }

  return value.map((entry, index) =>
    readRequiredAgentToolString(entry, `${key}[${index}]`)
  );
}

function readRequiredAgentToolObject(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object for this agent tool.`);
  }

  return value;
}

function readBulkRecordUpdates(
  value: unknown
): Array<{ patch: Record<string, unknown>; recordId: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("updates must be a non-empty array for this agent tool.");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`updates[${index}] must be an object for this agent tool.`);
    }

    return {
      patch: readRequiredAgentToolObject(entry["patch"], `updates[${index}].patch`),
      recordId: readRequiredAgentToolString(entry.recordId, `updates[${index}].recordId`)
    };
  });
}

function readOptionalAgentToolObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readPositiveInteger(value: number, key: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function readActivityHistoryLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("limit must be an integer between 1 and 100 for activity history reads.");
  }

  return value;
}

function readExplainablePermissionSurfaces(
  value: unknown
): Array<"direct-record-read" | "view-query" | "command-ingress" | "workflow-step" | "agent-tool"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const allowed = new Set([
    "direct-record-read",
    "view-query",
    "command-ingress",
    "workflow-step",
    "agent-tool"
  ]);
  const surfaces: Array<
    "direct-record-read" | "view-query" | "command-ingress" | "workflow-step" | "agent-tool"
  > = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new Error(
        "surfaces entries must be one of direct-record-read, view-query, command-ingress, workflow-step, or agent-tool."
      );
    }

    if (seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    surfaces.push(
      entry as "direct-record-read" | "view-query" | "command-ingress" | "workflow-step" | "agent-tool"
    );
  }

  return surfaces;
}

function explainPermissionsWithResolvedSnapshot(
  input: ExplainPermissionsToolInput,
  snapshot: EffectivePermissionSnapshot,
  permissionEngine: ReturnType<typeof createRuntime>["permissionEngine"],
  evaluationContext?: PermissionEvaluationContext
): Extract<AgentToolInvocationResult, { kind: "permission-explanation" }> {
  const field = snapshot.fields[input.fieldId];
  if (!field) {
    throw new SchemaMetadataAccessError(
      `Principal ${snapshot.principalId} is not allowed to inspect permission explanations for field ${input.fieldId}.`,
      {
        hiddenFieldIds: [input.fieldId]
      }
    );
  }

  return {
    explanation: {
      ...permissionEngine.explainFieldAccess(
        {
          fieldId: field.fieldId,
          fieldType: field.fieldType
        },
        input.surfaces,
        snapshot,
        evaluationContext
      ),
      scope: {
        recordId: input.recordId ?? null,
        tableId: input.tableId ?? null,
        viewId: input.viewId ?? null,
        workspaceId: input.workspaceId
      }
    },
    kind: "permission-explanation"
  };
}

type PermissionContextFieldRow = {
  config_json: string;
  field_key: string;
  field_type: string;
  id: string;
};

async function resolvePermissionEvaluationContext(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  input: {
    principalId: string;
    recordId?: string;
    tableId?: string;
    workspaceId: string;
  }
): Promise<PermissionEvaluationContext | undefined> {
  if (!input.recordId || !input.tableId) {
    return undefined;
  }
  const recordId = input.recordId;

  const detail = await readRecordDetail(db, input.workspaceId, input.tableId, recordId);
  if (!detail?.projection) {
    return undefined;
  }

  const fieldRows = await db
    .prepare(
      `SELECT id, field_key, field_type, config_json
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.tableId)
    .all<PermissionContextFieldRow>();
  const projection = JSON.parse(detail.projection.projection_json) as {
    fields?: Record<string, unknown>;
  };
  const principalAliases = Object.fromEntries(
    (fieldRows.results ?? [])
      .map((field) => ({
        config: JSON.parse(field.config_json) as JsonValue,
        fieldId: field.id,
        fieldKey: field.field_key,
        fieldType: field.field_type
      }))
      .filter((field) => field.fieldType === "principal.user")
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId))
      .flatMap((field) => {
        const aliases = fieldTypeRegistry
          .require(field.fieldType)
          .getWorkflowBindingAliases({
            fieldConfig: field.config,
            fieldType: field.fieldType
          })
          .filter((alias) => alias.isCanonical === true && alias.binding.startsWith("row."));
        const rawPrincipalValue = projection.fields?.[field.fieldKey];
        const principalIds = Array.isArray(rawPrincipalValue)
          ? rawPrincipalValue.filter((value): value is string => typeof value === "string")
          : typeof rawPrincipalValue === "string"
            ? [rawPrincipalValue]
            : [];

        return aliases.map((alias) => [
          alias.binding,
          {
            alias: alias.binding,
            fieldId: field.fieldId,
            fieldKey: field.fieldKey,
            fieldType: field.fieldType,
            matchesPrincipal: principalIds.includes(input.principalId),
            principalIds,
            recordId
          }
        ] as const);
      })
  );

  if (Object.keys(principalAliases).length === 0) {
    return undefined;
  }

  return {
    principalAliases,
    rowOwner: principalAliases["row.owner"]
  };
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
  if (toolId === "inspectWorkspace" || toolId === "inspectApp" || toolId === "createApp" || toolId === "createTable") {
    return {
      ok: true,
      scope: {
        kind: "workspace"
      }
    };
  }

  if (toolId === "readWorkspaceActivityHistory" || toolId === "readAppActivityHistory") {
    return {
      ok: true,
      scope: {
        kind: "workspace"
      }
    };
  }

  if (toolId === "explainPermissions" || toolId === "previewPermissionPersona") {
    const viewId = readNonEmptyString(input.viewId);
    const tableId = readNonEmptyString(input.tableId);

    if (viewId && tableId) {
      return {
        ok: true,
        scope: {
          kind: "view",
          tableId,
          viewId
        }
      };
    }
  }

  if (toolId === "queryView") {
    const tableId = readNonEmptyString(input.tableId);
    const viewId = readNonEmptyString(input.viewId);

    if (!tableId || !viewId) {
      return {
        message: "tableId and viewId are required to resolve permissions for agent tool queryView.",
        ok: false
      };
    }

    return {
      ok: true,
      scope: {
        kind: "view",
        tableId,
        viewId
      }
    };
  }

  if (toolId === "createRecord") {
    const tableId = readNonEmptyString(input.tableId);
    const viewId = readNonEmptyString(input.viewId);

    if (tableId && viewId) {
      return {
        ok: true,
        scope: {
          kind: "view",
          tableId,
          viewId
        }
      };
    }
  }

  if (toolId === "inspectViewDefinition") {
    const tableId = readNonEmptyString(input.tableId);
    const viewId = readNonEmptyString(input.viewId);

    if (!tableId || !viewId) {
      return {
        message:
          "tableId and viewId are required to resolve permissions for agent tool inspectViewDefinition.",
        ok: false
      };
    }

    return {
      ok: true,
      scope: {
        kind: "view",
        tableId,
        viewId
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

  if (command.commandType === "workflow.create" || command.commandType === "workflow.update") {
    const payloadTableId = readWorkflowTriggerTableId(command.payload);
    if (payloadTableId) {
      return {
        kind: "table",
        tableId: payloadTableId
      };
    }

    const explicitPayloadTableId = readNonEmptyString(command.payload?.tableId);
    if (explicitPayloadTableId) {
      return {
        kind: "table",
        tableId: explicitPayloadTableId
      };
    }

    if (command.commandType === "workflow.update") {
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
  }

  if (
    command.commandType === "workflow.publish" ||
    command.commandType === "workflow.pause" ||
    command.commandType === "workflow.manual"
  ) {
    const workflowId = readNonEmptyString(command.payload?.workflowId);
    if (workflowId && typeof command.workspaceId === "string" && command.workspaceId.length > 0) {
      const workflowTableId = await readWorkflowTriggerTableIdFromDatabase(
        db,
        command.workspaceId,
        workflowId,
        {
          publishedOnly: command.commandType === "workflow.manual"
        }
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
  request: Request,
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

  let principalId = readNonEmptyString(input.principalId);
  if (!principalId) {
    const sessionPrincipal = await resolveSessionPrincipalForWorkspace(request, env, workspaceId);
    if ("response" in sessionPrincipal) {
      return {
        response: sessionPrincipal.response
      };
    }

    principalId = sessionPrincipal.principalId;
  }
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
  request: Request,
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
  let principalId = readNonEmptyString(input.principalId);
  if (!principalId) {
    const sessionPrincipal = await resolveSessionPrincipalForWorkspace(request, env, input.workspaceId);
    if ("response" in sessionPrincipal) {
      return {
        response: sessionPrincipal.response
      };
    }

    principalId = sessionPrincipal.principalId;
  }
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
  request: Request,
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
  let principalId = readNonEmptyString(input.principalId);
  if (!principalId) {
    const sessionPrincipal = await resolveSessionPrincipalForWorkspace(request, env, input.workspaceId);
    if ("response" in sessionPrincipal) {
      return {
        response: sessionPrincipal.response
      };
    }

    principalId = sessionPrincipal.principalId;
  }
  if (!principalId) {
    return {
      response: badRequest("principalId is required for workspace catalog ingress.")
    };
  }

  const membershipResponse = await enforceActiveUserWorkspaceMembership(env.DB, {
    mode: "user",
    principalId,
    workspaceId: input.workspaceId
  });
  if (membershipResponse) {
    return {
      response: membershipResponse
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

async function enforceActiveUserWorkspaceMembership(
  db: D1Database,
  input: {
    mode: "agent" | "user" | "workflow";
    principalId: string;
    workspaceId: string;
  }
): Promise<Response | null> {
  if (input.mode !== "user") {
    return null;
  }

  const repository = createCloudTableD1Repository(db);
  const hasFoundation = await repository.workspaceHasMembershipFoundation(input.workspaceId);
  if (!hasFoundation) {
    return null;
  }

  const isMember = await repository.userHasActiveWorkspaceMembership({
    principalId: input.principalId,
    workspaceId: input.workspaceId
  });
  if (isMember) {
    return null;
  }

  return forbidden(
    `Principal ${input.principalId} is not an active workspace member for ${input.workspaceId}.`
  );
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

async function readWorkflowTriggerTableIdFromDatabase(
  db: D1Database,
  workspaceId: string,
  workflowId: string,
  options?: {
    publishedOnly?: boolean;
  }
): Promise<string | null> {
  const row = options?.publishedOnly
    ? await db
        .prepare(
          `SELECT workflow_versions.definition_json
           FROM workflows
           JOIN workflow_versions
             ON workflow_versions.workflow_id = workflows.id
            AND workflow_versions.workspace_id = workflows.workspace_id
           WHERE workflows.workspace_id = ?
             AND workflows.id = ?
             AND workflows.archived_at IS NULL
             AND workflow_versions.published_at IS NOT NULL
           ORDER BY workflow_versions.version DESC
           LIMIT 1`
        )
        .bind(workspaceId, workflowId)
        .first<{ definition_json: string }>()
    : await db
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
