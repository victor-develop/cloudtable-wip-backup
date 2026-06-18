import { createAgentToolRegistry } from "../core/agent-tools/registry";
import type { AgentToolDefinition, AgentToolRegistry } from "../core/agent-tools/types";
import { createAggregateOperationRegistry } from "../core/aggregates/registry";
import { createCommandBus } from "../core/commands/command-bus";
import { createEventLedger } from "../core/events/event-ledger";
import { createFieldTypeRegistry } from "../core/field-types/registry";
import { createPermissionEngine } from "../core/permissions/engine";
import { createViewPlanner } from "../core/views/planner";
import { createWorkflowOperatorRegistry } from "../core/workflows/operator-registry";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import type { CloudTableEnv } from "./env";
import {
  readAppActivityHistory,
  readRecordActivityHistory,
  readTableActivityHistory,
  readWorkspaceActivityHistory
} from "./activity-history-read";
import { readRecordDetail, readRecordFields } from "./direct-record-read";
import type { PermissionProjectionInput } from "../core/permissions/types";
import { readViewQuery } from "./view-query-read";
import {
  readWorkflowHistoryForRun,
  readWorkflowHistoryForWorkflow,
  requestWorkflowDeadLetterReplay
} from "./workflow-operations";
import { readWorkflowDefinitionMetadata } from "./workflow-definition";
import { previewWorkflowTestRun } from "./workflow-runtime";
import { createAppInspector } from "./app-inspector";
import {
  readTableSchemaMetadata,
  readViewDefinitionMetadata,
  SchemaMetadataAccessError
} from "./schema-metadata-read";
import { createWorkspaceInspector } from "./workspace-inspector";

function createRecordInspector(
  env: CloudTableEnv,
  runtime: {
    fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
    permissionEngine: ReturnType<typeof createPermissionEngine>;
  },
  snapshot?: EffectivePermissionSnapshot
) {
  return {
    async read(input: { recordId: string; tableId: string; workspaceId: string }) {
      const detail = await readRecordDetail(env.DB, input.workspaceId, input.tableId, input.recordId);
      if (!detail) {
        return null;
      }

      const rawProjection = detail.projection
        ? (JSON.parse(detail.projection.projection_json) as {
            fields?: Record<string, unknown>;
          })
        : null;

      if (snapshot && rawProjection) {
        const recordFields = await readRecordFields(env.DB, input.workspaceId, input.tableId);
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

        return {
          projection: {
            fields: permissionedFields
          },
          projectionVersion: detail.projection?.projection_version ?? 0,
          record: {
            ...detail.record,
            lastEventId: detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
          },
          surface: {
            diagnostics: projected.diagnostics,
            hiddenFieldIds: projected.hiddenFieldIds,
            redactedFieldIds: projected.redactedFieldIds,
            redactionApplied: projected.redactedFieldIds.length > 0,
            states: projected.states
          }
        };
      }

      return {
        projection: rawProjection,
        projectionVersion: detail.projection?.projection_version ?? 0,
        record: {
          ...detail.record,
          lastEventId: detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
        }
      };
    }
  };
}

function createActivityHistoryReader(
  env: CloudTableEnv,
  runtime: {
    fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
  }
) {
  return {
    async read(input: {
      appId?: string;
      beforeTableSequence?: number;
      beforeWorkspaceSequence?: number;
      limit?: number;
      recordId?: string;
      tableId?: string;
      workspaceId: string;
    }) {
      const limit = input.limit ?? 25;
      if (input.appId) {
        const history = await readAppActivityHistory(env.DB, runtime.fieldTypeRegistry, {
          appId: input.appId,
          beforeWorkspaceSequence: input.beforeWorkspaceSequence ?? null,
          limit,
          workspaceId: input.workspaceId
        });

        return {
          appId: input.appId,
          entries: history.entries,
          page: {
            limit,
            nextBeforeWorkspaceSequence: history.nextBeforeWorkspaceSequence
          },
          workspaceId: input.workspaceId
        };
      }

      if (!input.tableId) {
        const history = await readWorkspaceActivityHistory(env.DB, runtime.fieldTypeRegistry, {
          beforeWorkspaceSequence: input.beforeWorkspaceSequence ?? null,
          limit,
          workspaceId: input.workspaceId
        });

        return {
          entries: history.entries,
          page: {
            limit,
            nextBeforeWorkspaceSequence: history.nextBeforeWorkspaceSequence
          },
          workspaceId: input.workspaceId
        };
      }

      if (input.recordId) {
        const detail = await readRecordDetail(env.DB, input.workspaceId, input.tableId, input.recordId);
        if (!detail) {
          return {
            entries: [],
            page: {
              limit,
              nextBeforeTableSequence: null
            },
            record: null,
            workspaceId: input.workspaceId
          };
        }

        const history = await readRecordActivityHistory(env.DB, runtime.fieldTypeRegistry, {
          beforeTableSequence: input.beforeTableSequence ?? null,
          limit,
          recordId: input.recordId,
          tableId: input.tableId,
          workspaceId: input.workspaceId
        });

        return {
          entries: history.entries,
          page: {
            limit,
            nextBeforeTableSequence: history.nextBeforeTableSequence
          },
          record: {
            ...detail.record,
            lastEventId: detail.projection?.last_event_id ?? detail.record.last_event_id ?? null
          },
          workspaceId: input.workspaceId
        };
      }

      const history = await readTableActivityHistory(env.DB, runtime.fieldTypeRegistry, {
        beforeTableSequence: input.beforeTableSequence ?? null,
        limit,
        tableId: input.tableId,
        workspaceId: input.workspaceId
      });

      return {
        entries: history.entries,
        page: {
          limit,
          nextBeforeTableSequence: history.nextBeforeTableSequence
        },
        tableId: input.tableId,
        workspaceId: input.workspaceId
      };
    }
  };
}

function createTableSchemaInspector(
  env: CloudTableEnv,
  runtime: {
    fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
    permissionEngine: ReturnType<typeof createPermissionEngine>;
    viewPlanner: ReturnType<typeof createViewPlanner>;
    workflowOperatorRegistry: ReturnType<typeof createWorkflowOperatorRegistry>;
  },
  snapshot?: EffectivePermissionSnapshot
) {
  return {
    async read(input: { tableId: string; workspaceId: string }) {
      const detail = await readTableSchemaMetadata(
        env.DB,
        runtime.fieldTypeRegistry,
        runtime.viewPlanner,
        runtime.workflowOperatorRegistry,
        input
      );
      if (!detail || !snapshot) {
        return detail;
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
              snapshot
            ).readState === "hidden"
        )
        .map((field) => field.fieldId);
      if (hiddenFieldIds.length > 0) {
        throw new SchemaMetadataAccessError(
          `Principal ${snapshot.principalId} is not allowed to inspect table schema metadata for ${input.tableId}.`,
          {
            hiddenFieldIds
          }
        );
      }

      return detail;
    }
  };
}

function createViewDefinitionInspector(
  env: CloudTableEnv,
  runtime: {
    permissionEngine: ReturnType<typeof createPermissionEngine>;
  },
  snapshot?: EffectivePermissionSnapshot
) {
  return {
    async read(input: { tableId: string; viewId: string; workspaceId: string }) {
      const detail = await readViewDefinitionMetadata(env.DB, input);
      if (!detail || !snapshot) {
        return detail;
      }

      const referencedFieldIds = Array.from(
        new Set([
          ...detail.definition.visibleFieldIds,
          ...detail.definition.sortFieldIds,
          ...(detail.definition.groupByFieldId ? [detail.definition.groupByFieldId] : [])
        ])
      );
      const hiddenFieldIds = referencedFieldIds.filter((fieldId) => {
        const field = snapshot.fields[fieldId];
        if (!field) {
          return false;
        }

        return runtime.permissionEngine.evaluateFieldAccess(field, "view-query", snapshot).readState === "hidden";
      });
      if (hiddenFieldIds.length > 0) {
        throw new SchemaMetadataAccessError(
          `Principal ${snapshot.principalId} is not allowed to inspect saved view definition metadata for ${input.viewId}.`,
          {
            hiddenFieldIds
          }
        );
      }

      const protectedFilterFieldIds = new Set(
        detail.definition.filters
          .map((filter) => filter.fieldId)
          .filter((fieldId) => snapshot.fields[fieldId]?.read !== "visible")
      );

      return {
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
      };
    }
  };
}

function createWorkflowDefinitionInspector(
  env: CloudTableEnv,
  runtime: {
    fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
    permissionEngine: ReturnType<typeof createPermissionEngine>;
    workflowOperatorRegistry: ReturnType<typeof createWorkflowOperatorRegistry>;
  },
  snapshot?: EffectivePermissionSnapshot
) {
  return {
    async read(input: { workflowId: string; workspaceId: string }) {
      const detail = await readWorkflowDefinitionMetadata(
        env.DB,
        runtime.fieldTypeRegistry,
        runtime.workflowOperatorRegistry,
        input.workspaceId,
        input.workflowId
      );
      if (!detail || !snapshot) {
        if (!detail) {
          return detail;
        }

        const { referencedFieldIds: _referencedFieldIds, ...response } = detail;
        return response;
      }

      const protectedFieldIds = detail.referencedFieldIds.filter((fieldId) => {
        const field = snapshot.fields[fieldId];
        if (!field) {
          return true;
        }

        return runtime.permissionEngine.evaluateFieldAccess(field, "view-query", snapshot).readState === "hidden";
      });
      if (protectedFieldIds.length > 0) {
        throw new SchemaMetadataAccessError(
          `Principal ${snapshot.principalId} is not allowed to inspect workflow definition metadata for ${input.workflowId}.`,
          {
            protectedFieldIds
          }
        );
      }

      const { referencedFieldIds: _referencedFieldIds, ...response } = detail;
      return response;
    }
  };
}

function createPermissionPersonaPreviewReader(
  env: CloudTableEnv,
  runtime: {
    fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
    permissionEngine: ReturnType<typeof createPermissionEngine>;
    viewPlanner: ReturnType<typeof createViewPlanner>;
    workflowOperatorRegistry: ReturnType<typeof createWorkflowOperatorRegistry>;
  },
  getAgentToolRegistry: () => AgentToolRegistry,
  snapshot?: EffectivePermissionSnapshot
) {
  return {
    async read(input: { tableId: string; viewId: string; workspaceId: string }) {
      const [table, view, viewQuery] = await Promise.all([
        readTableSchemaMetadata(
          env.DB,
          runtime.fieldTypeRegistry,
          runtime.viewPlanner,
          runtime.workflowOperatorRegistry,
          {
          tableId: input.tableId,
          workspaceId: input.workspaceId
          }
        ),
        readViewDefinitionMetadata(env.DB, {
          tableId: input.tableId,
          viewId: input.viewId,
          workspaceId: input.workspaceId
        }),
        readViewQuery(
          env.DB,
          runtime.fieldTypeRegistry,
          runtime.viewPlanner,
          runtime.workflowOperatorRegistry,
          {
            snapshot,
            tableId: input.tableId,
            viewId: input.viewId,
            workspaceId: input.workspaceId
          }
        )
      ]);

      if (!table || !view || !viewQuery) {
        return null;
      }

      const configuredVisibleFieldIds = new Set(view.definition.visibleFieldIds);
      const configuredFilterFieldIds = new Set(view.definition.filterFieldIds);
      const configuredSortFieldIds = new Set(view.definition.sortFieldIds);
      const groupedFieldId = view.definition.groupByFieldId;
      const fieldDescriptors = table.fields.map((field) => ({
        fieldConfig: field.config,
        fieldId: field.fieldId,
        fieldType: field.fieldType
      }));
      const agentToolAccess = getAgentToolRegistry().listAccessible(fieldDescriptors, snapshot);
      const agentToolDefinitions = new Map<string, AgentToolDefinition>(
        getAgentToolRegistry().list().map((tool) => [tool.id, tool] as const)
      );

      const summarizeSurface = (
        surface: "view-query" | "command-ingress" | "workflow-step" | "agent-tool"
      ) => {
        const hiddenFieldIds: string[] = [];
        const readOnlyFieldIds: string[] = [];
        const redactedFieldIds: string[] = [];
        const visibleFieldIds: string[] = [];
        const writableFieldIds: string[] = [];

        for (const field of fieldDescriptors) {
          const decision = runtime.permissionEngine.evaluateFieldAccess(field, surface, snapshot);
          if (decision.readState === "hidden") {
            hiddenFieldIds.push(field.fieldId);
            continue;
          }

          visibleFieldIds.push(field.fieldId);
          if (decision.readState === "redacted") {
            redactedFieldIds.push(field.fieldId);
          }
          if (decision.writeAllowed) {
            writableFieldIds.push(field.fieldId);
          } else {
            readOnlyFieldIds.push(field.fieldId);
          }
        }

        return {
          hiddenFieldIds,
          readOnlyFieldIds,
          redactedFieldIds,
          visibleFieldIds,
          writableFieldIds
        };
      };

      const viewQuerySurface = summarizeSurface("view-query");
      const commandSurface = summarizeSurface("command-ingress");
      const workflowSurface = summarizeSurface("workflow-step");
      const agentSurface = summarizeSurface("agent-tool");

      return {
        actions: {
          allowedMutatingToolIds: agentToolAccess
            .filter((tool) => tool.allowed && agentToolDefinitions.get(tool.toolId)?.mutating)
            .map((tool) => tool.toolId),
          allowedToolIds: agentToolAccess.filter((tool) => tool.allowed).map((tool) => tool.toolId),
          blockedMutatingToolIds: agentToolAccess
            .filter((tool) => !tool.allowed && agentToolDefinitions.get(tool.toolId)?.mutating)
            .map((tool) => tool.toolId),
          blockedToolIds: agentToolAccess.filter((tool) => !tool.allowed).map((tool) => tool.toolId),
          tools: agentToolAccess.map((tool) => {
            const definition = agentToolDefinitions.get(tool.toolId);
            return {
              allowed: tool.allowed,
              hiddenFieldIds: tool.hiddenFieldIds,
              mutating: definition?.mutating ?? false,
              mutationTarget: definition?.mutationTarget ?? "none",
              phase: definition?.phase ?? "draft",
              reason: tool.reason,
              scope: definition?.scope ?? "table",
              toolId: tool.toolId,
              visibleFieldIds: tool.visibleFieldIds
            };
          })
        },
        fields: table.fields.map((field) => {
          const descriptor = {
            fieldConfig: field.config,
            fieldId: field.fieldId,
            fieldType: field.fieldType
          };
          const viewDecision = runtime.permissionEngine.evaluateFieldAccess(
            descriptor,
            "view-query",
            snapshot
          );
          const commandDecision = runtime.permissionEngine.evaluateFieldAccess(
            descriptor,
            "command-ingress",
            snapshot
          );
          const workflowDecision = runtime.permissionEngine.evaluateFieldAccess(
            descriptor,
            "workflow-step",
            snapshot
          );
          const agentDecision = runtime.permissionEngine.evaluateFieldAccess(
            descriptor,
            "agent-tool",
            snapshot
          );

          return {
            configuredVisible: configuredVisibleFieldIds.has(field.fieldId),
            fieldId: field.fieldId,
            fieldKey: field.fieldKey,
            fieldType: field.fieldType,
            hiddenByView: !configuredVisibleFieldIds.has(field.fieldId),
            label: field.label,
            referencedByFilter: configuredFilterFieldIds.has(field.fieldId),
            referencedByGroup: groupedFieldId === field.fieldId,
            referencedBySort: configuredSortFieldIds.has(field.fieldId),
            surfaces: {
              agentTool: agentDecision,
              commandIngress: commandDecision,
              viewQuery: viewDecision,
              workflowStep: workflowDecision
            }
          };
        }),
        principalId: snapshot?.principalId ?? null,
        rows: viewQuery.rows,
        table: {
          appId: table.appId,
          schemaEpoch: table.schemaEpoch,
          tableId: table.tableId,
          tableName: table.tableName,
          tableSchemaVersion: table.tableSchemaVersion,
          tableSlug: table.tableSlug
        },
        view: {
          configuredVisibleFieldIds: view.definition.visibleFieldIds,
          filters: view.definition.filters.map((filter) => ({
            ...(filter.comparator ? { comparator: filter.comparator } : {}),
            fieldId: filter.fieldId,
            operatorId: filter.operatorId,
            protected: snapshot?.fields[filter.fieldId]?.read !== "visible",
            ...(snapshot?.fields[filter.fieldId]?.read === "visible" && filter.value !== undefined
              ? { value: filter.value }
              : {})
          })),
          groupByFieldId: view.definition.groupByFieldId,
          sortFieldIds: view.definition.sortFieldIds,
          surfaces: {
            agentTool: agentSurface,
            commandIngress: commandSurface,
            viewQuery: viewQuerySurface,
            workflowStep: workflowSurface
          },
          viewId: view.viewId,
          viewKey: view.viewKey,
          viewName: view.viewName,
          viewQuery: viewQuery.view,
          viewSchemaVersion: view.viewSchemaVersion
        },
        workspaceId: input.workspaceId
      };
    }
  };
}

export type CloudTableRuntime = {
  appInspector: ReturnType<typeof createAppInspector>;
  aggregateOperationRegistry: ReturnType<typeof createAggregateOperationRegistry>;
  commandBus: ReturnType<typeof createCommandBus>;
  eventLedger: ReturnType<typeof createEventLedger>;
  fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
  permissionEngine: ReturnType<typeof createPermissionEngine>;
  workflowOperatorRegistry: ReturnType<typeof createWorkflowOperatorRegistry>;
  viewPlanner: ReturnType<typeof createViewPlanner>;
  agentToolRegistry: ReturnType<typeof createAgentToolRegistry>;
};

export function createRuntime(env: CloudTableEnv): CloudTableRuntime {
  const aggregateOperationRegistry = createAggregateOperationRegistry();
  const fieldTypeRegistry = createFieldTypeRegistry();
  const workflowOperatorRegistry = createWorkflowOperatorRegistry();
  const permissionEngine = createPermissionEngine(fieldTypeRegistry);
  const appInspector = createAppInspector(env.DB);
  const eventLedger = createEventLedger(env.DB, fieldTypeRegistry);
  const commandBus = createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    workflowOperatorRegistry
  });
  const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
  let agentToolRegistry: ReturnType<typeof createAgentToolRegistry>;
  const workspaceInspector = createWorkspaceInspector(
    env.DB,
    aggregateOperationRegistry,
    fieldTypeRegistry,
    viewPlanner,
    workflowOperatorRegistry,
    () => {
      if (!agentToolRegistry) {
        throw new Error("Agent tool registry requested before initialization.");
      }

      return agentToolRegistry;
    }
  );
  const workflowHistoryReader = {
    read(input: { workflowId: string; workspaceId: string }) {
      return readWorkflowHistoryForWorkflow(env.DB, input.workspaceId, input.workflowId);
    }
  };
  const workflowRunReader = {
    read(input: { workflowRunId: string; workspaceId: string }) {
      return readWorkflowHistoryForRun(env.DB, input.workspaceId, input.workflowRunId);
    }
  };
  const workflowTestPreviewReader = {
    read(input: { recordId: string; selectedFieldId?: string; workflowId: string; workspaceId: string }) {
      return previewWorkflowTestRun(env, input);
    }
  };
  const workflowDeadLetterReplayRequester = {
    requestReplay(input: {
      actor: {
        mode: "agent";
        principalId: string;
      };
      deadLetterId: string;
      replayRequestId?: string;
      workspaceId: string;
    }) {
      const replayRequestId =
        input.replayRequestId ?? `dead-letter-replay:${input.deadLetterId}`;
      return requestWorkflowDeadLetterReplay(env, {
        deadLetterId: input.deadLetterId,
        principalId: input.actor.principalId,
        replayRequestId
      }).then((result) =>
        result.ok
          ? {
              deadLetterId: input.deadLetterId,
              replayRequestId,
              status: result.status
            }
          : {
              deadLetterId: input.deadLetterId,
              message: result.message,
              reason: result.reason,
              replayRequestId,
              status: "rejected" as const
            }
      );
    }
  };
  const tableSchemaInspector = createTableSchemaInspector(
    env,
    {
      fieldTypeRegistry,
      permissionEngine,
      viewPlanner,
      workflowOperatorRegistry
    },
    undefined
  );
  const viewDefinitionInspector = createViewDefinitionInspector(
    env,
    {
      permissionEngine
    },
    undefined
  );
  const workflowDefinitionInspector = createWorkflowDefinitionInspector(
    env,
    {
      fieldTypeRegistry,
      permissionEngine,
      workflowOperatorRegistry
    },
    undefined
  );
  const recordInspector = createRecordInspector(
    env,
    {
      fieldTypeRegistry,
      permissionEngine
    },
    undefined
  );
  const activityHistoryReader = createActivityHistoryReader(env, {
    fieldTypeRegistry
  });
  const viewQueryReader = {
    read(input: { tableId: string; viewId: string; workspaceId: string }) {
      return readViewQuery(
        env.DB,
        fieldTypeRegistry,
        viewPlanner,
        workflowOperatorRegistry,
        input
      );
    }
  };
  const permissionPersonaPreviewReader = createPermissionPersonaPreviewReader(
    env,
    {
      fieldTypeRegistry,
      permissionEngine,
      viewPlanner,
      workflowOperatorRegistry
    },
    () => agentToolRegistry,
    undefined
  );
  agentToolRegistry = createAgentToolRegistry({
    appInspector,
    activityHistoryReader,
    commandBus,
    workflowTestPreviewReader,
    permissionPersonaPreviewReader,
    permissionEngine,
    tableSchemaInspector,
    viewDefinitionInspector,
    workflowDefinitionInspector,
    recordInspector,
    viewPlanner,
    viewQueryReader,
    workflowDeadLetterReplayRequester,
    workflowHistoryReader,
    workflowRunReader,
    workflowOperatorRegistry,
    workspaceInspector
  });

  return {
    appInspector,
    aggregateOperationRegistry,
    agentToolRegistry,
    commandBus,
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    viewPlanner,
    workflowOperatorRegistry
  };
}

export function createRuntimeWithSnapshot(
  env: CloudTableEnv,
  snapshot?: EffectivePermissionSnapshot
): CloudTableRuntime {
  const aggregateOperationRegistry = createAggregateOperationRegistry();
  const fieldTypeRegistry = createFieldTypeRegistry();
  const workflowOperatorRegistry = createWorkflowOperatorRegistry();
  const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
    snapshot
  });
  const eventLedger = createEventLedger(env.DB, fieldTypeRegistry);
  const commandBus = createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    workflowOperatorRegistry
  });
  const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
  const appInspector = createAppInspector(env.DB);
  let agentToolRegistry: ReturnType<typeof createAgentToolRegistry>;
  const workspaceInspector = createWorkspaceInspector(
    env.DB,
    aggregateOperationRegistry,
    fieldTypeRegistry,
    viewPlanner,
    workflowOperatorRegistry,
    () => {
      if (!agentToolRegistry) {
        throw new Error("Agent tool registry requested before initialization.");
      }

      return agentToolRegistry;
    }
  );
  const workflowHistoryReader = {
    read(input: { workflowId: string; workspaceId: string }) {
      return readWorkflowHistoryForWorkflow(env.DB, input.workspaceId, input.workflowId);
    }
  };
  const workflowRunReader = {
    read(input: { workflowRunId: string; workspaceId: string }) {
      return readWorkflowHistoryForRun(env.DB, input.workspaceId, input.workflowRunId);
    }
  };
  const workflowTestPreviewReader = {
    read(input: { recordId: string; selectedFieldId?: string; workflowId: string; workspaceId: string }) {
      return previewWorkflowTestRun(env, input);
    }
  };
  const workflowDeadLetterReplayRequester = {
    requestReplay(input: {
      actor: {
        mode: "agent";
        principalId: string;
      };
      deadLetterId: string;
      replayRequestId?: string;
      workspaceId: string;
    }) {
      const replayRequestId =
        input.replayRequestId ?? `dead-letter-replay:${input.deadLetterId}`;
      return requestWorkflowDeadLetterReplay(env, {
        deadLetterId: input.deadLetterId,
        principalId: input.actor.principalId,
        replayRequestId
      }).then((result) =>
        result.ok
          ? {
              deadLetterId: input.deadLetterId,
              replayRequestId,
              status: result.status
            }
          : {
              deadLetterId: input.deadLetterId,
              message: result.message,
              reason: result.reason,
              replayRequestId,
              status: "rejected" as const
            }
      );
    }
  };
  const tableSchemaInspector = createTableSchemaInspector(
    env,
    {
      fieldTypeRegistry,
      permissionEngine,
      viewPlanner,
      workflowOperatorRegistry
    },
    snapshot
  );
  const viewDefinitionInspector = createViewDefinitionInspector(
    env,
    {
      permissionEngine
    },
    snapshot
  );
  const workflowDefinitionInspector = createWorkflowDefinitionInspector(
    env,
    {
      fieldTypeRegistry,
      permissionEngine,
      workflowOperatorRegistry
    },
    snapshot
  );
  const recordInspector = createRecordInspector(
    env,
    {
      fieldTypeRegistry,
      permissionEngine
    },
    snapshot
  );
  const activityHistoryReader = createActivityHistoryReader(env, {
    fieldTypeRegistry
  });
  const viewQueryReader = {
    read(input: { tableId: string; viewId: string; workspaceId: string }) {
      return readViewQuery(
        env.DB,
        fieldTypeRegistry,
        viewPlanner,
        workflowOperatorRegistry,
        {
          ...input,
          snapshot
        }
      );
    }
  };
  const permissionPersonaPreviewReader = createPermissionPersonaPreviewReader(
    env,
    {
      fieldTypeRegistry,
      permissionEngine,
      viewPlanner,
      workflowOperatorRegistry
    },
    () => agentToolRegistry,
    snapshot
  );
  agentToolRegistry = createAgentToolRegistry({
    appInspector,
    activityHistoryReader,
    commandBus,
    workflowTestPreviewReader,
    permissionPersonaPreviewReader,
    permissionEngine,
    tableSchemaInspector,
    viewDefinitionInspector,
    workflowDefinitionInspector,
    recordInspector,
    viewPlanner,
    viewQueryReader,
    workflowDeadLetterReplayRequester,
    workflowHistoryReader,
    workflowRunReader,
    workflowOperatorRegistry,
    workspaceInspector
  });

  return {
    appInspector,
    aggregateOperationRegistry,
    agentToolRegistry,
    commandBus,
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    viewPlanner,
    workflowOperatorRegistry
  };
}
