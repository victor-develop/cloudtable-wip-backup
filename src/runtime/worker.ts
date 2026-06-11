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
import type { JsonValue } from "../core/field-types/types";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import type { PermissionProjectionInput } from "../core/permissions/types";
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
import { badRequest, conflict, forbidden, json, methodNotAllowed, notFound } from "./http";
import type { CloudTableEnv } from "./env";
import { enqueueScheduledWorkflowDispatches } from "./workflow-runtime";
import {
  readWorkflowDefinitionMetadata,
  readWorkflowExecutionCandidate,
  readWorkflowTriggerTableId
} from "./workflow-definition";
import { createWorkspaceInspector } from "./workspace-inspector";
import { serializeWorkflowOperatorManifest } from "../core/workflows/manifest";
import { createWorkflowOperatorRegistry } from "../core/workflows/operator-registry";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import { drainPendingOutboxEntries } from "./queue-publisher";

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
      fieldTypes: runtime.fieldTypeRegistry.list().map(serializeFieldTypeManifest),
      workflowOperators: runtime.workflowOperatorRegistry.list().map(serializeWorkflowOperatorManifest),
      agentTools: runtime.agentToolRegistry.list().map(serializeAgentToolManifest)
    });
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

    const history = await readWorkspaceActivityHistory(env.DB, {
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

    const auth = await resolveWorkspaceCatalogAccess(env, {
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

    const history = await readAppActivityHistory(env.DB, {
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

  const fieldTypeCatalogMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/field-types$/);
  if (fieldTypeCatalogMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    const workspaceId = fieldTypeCatalogMatch[1]!;
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

    const history = await readRecordActivityHistory(env.DB, {
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

    const history = await readTableActivityHistory(env.DB, {
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
  const repository = createCloudTableD1Repository(env.DB);
  await drainPendingOutboxEntries(
    env,
    repository,
    new Date(controller.scheduledTime).toISOString()
  );
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

  const actorPrincipalId = readNonEmptyString(hydratedCommand.actor?.principalId);
  const actorMode = hydratedCommand.actor?.mode;
  if (!actorPrincipalId || (actorMode !== "user" && actorMode !== "workflow" && actorMode !== "agent")) {
    return {
      response: badRequest("actor.principalId and actor.mode are required for command ingress.")
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
    ? await resolveWorkflowOperationsAccess(env, {
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
              permissionedRuntime.permissionEngine
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
      surfaces,
      tableId,
      viewId: viewId ?? undefined,
      workspaceId
    },
    resolvedSnapshot.snapshot,
    runtime.permissionEngine
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

  const result = await permissionedRuntime.agentToolRegistry.invoke(invocation);
  if (result.kind !== "permission-explanation") {
    throw new Error("Permission explanation ingress returned an unexpected agent tool result.");
  }

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
  permissionEngine: ReturnType<typeof createRuntime>["permissionEngine"]
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
        snapshot
      ),
      scope: {
        tableId: input.tableId ?? null,
        viewId: input.viewId ?? null,
        workspaceId: input.workspaceId
      }
    },
    kind: "permission-explanation"
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
