import { describe, expect, it } from "vitest";

import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope, CommandResult } from "../../../../src/core/commands/types";
import { scopeKeyForCommand } from "../../../../src/core/commands/transcript";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { createViewPlanner } from "../../../../src/core/views/planner";
import { executeWorkflowAction } from "../../../../src/core/workflows/execution";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import type {
  WorkflowActionDefinition,
  WorkflowActionExecutor
} from "../../../../src/core/workflows/types";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

const logicalTime = "2026-06-06T00:00:00.000Z";
const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

const snapshot: EffectivePermissionSnapshot = {
  snapshotId: "snap_matrix_001",
  workspaceId: "ws_demo",
  principalId: "usr_alice",
  policyRevision: 7,
  schemaEpoch: 3,
  scopeHash: "scope:table:tbl_tasks",
  commandTypes: ["cell.set", "field.create", "table.create"],
  fields: {
    title: {
      agent: true,
      fieldId: "title",
      fieldType: "text.single_line",
      read: "visible",
      workflow: true,
      write: true
    },
    salary: {
      agent: false,
      fieldId: "salary",
      fieldType: "number.decimal",
      read: "hidden",
      workflow: false,
      write: false
    },
    customer_note: {
      agent: false,
      fieldId: "customer_note",
      fieldType: "text.long",
      read: "redacted",
      workflow: true,
      write: true
    },
    internal_note: {
      agent: true,
      fieldId: "internal_note",
      fieldType: "text.long",
      read: "visible",
      workflow: false,
      write: true
    },
    health_score: {
      agent: true,
      fieldId: "health_score",
      fieldType: "computed.readonly",
      read: "visible",
      workflow: true,
      write: false
    }
  }
};

const permissionFields = [
  {
    fieldId: "title",
    fieldType: "text.single_line",
    value: "Q3 Renewal"
  },
  {
    fieldId: "salary",
    fieldType: "number.decimal",
    value: "120000"
  },
  {
    fieldId: "customer_note",
    fieldType: "text.long",
    value: "VIP renewal risk"
  },
  {
    fieldId: "internal_note",
    fieldType: "text.long",
    value: "Only humans should see this in workflow steps"
  }
] as const;

const registryFields = permissionFields.map(({ fieldId, fieldType }) => ({
  fieldId,
  fieldType
}));

function createHarness(overrides?: {
  snapshot?: EffectivePermissionSnapshot;
  idFactory?: (prefix: string) => string;
}) {
  const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
    snapshot: overrides?.snapshot
  });
  const eventLedger = new InMemoryEventLedger(logicalTime);
  const commandBus = createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    workflowOperatorRegistry,
    idFactory:
      overrides?.idFactory ??
      ((prefix) => `${prefix}_0001`),
    now() {
      return logicalTime;
    }
  });

  return {
    commandBus,
    eventLedger,
    permissionEngine
  };
}

function buildAcceptedResult(commandId: string): CommandResult {
  return {
    accepted: true,
    diagnostics: [],
    events: [],
    permission: {
      allowed: true,
      reasons: []
    },
    replayProjection: {
      acceptedCommandIds: [commandId],
      lastLogicalTime: logicalTime,
      receiptCount: 1,
      receipts: []
    },
    sideEffects: [],
    status: "accepted"
  };
}

function requireAction(id: string): WorkflowActionDefinition {
  const definition = workflowOperatorRegistry.require(id);
  if (definition.kind !== "action") {
    throw new Error(`Expected workflow action for ${id}`);
  }

  return definition;
}

describe("cloudtable MVP regression matrix", () => {
  it("covers the deterministic MVP semantic seams with stable snapshots", async () => {
    const matrix: Array<Record<string, unknown>> = [];

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["table.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_table_create_001",
        commandType: "table.create",
        idempotencyKey: "idem_table_create_001",
        payload: {
          appId: "app_ops",
          baseId: "base_ops",
          name: "Tasks",
          slug: "tasks",
          tableId: "tbl_tasks"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "table_creation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "table_create_basic"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_001",
        payload: {
          fieldId: "status",
          fieldKey: "status",
          fieldType: "text.single_line",
          label: "Status"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_creation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_create_basic"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_001",
        payload: {
          fieldId: "title",
          recordId: "rec_001",
          value: "Renewal committed"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "record_and_cell_writes",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "cell_set_write"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["workflow.create", "workflow.publish", "workflow.pause"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_workflow_publish_001",
        commandType: "workflow.publish",
        idempotencyKey: "idem_workflow_publish_001",
        payload: {
          workflowId: "wf_follow_up"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "workflow_lifecycle",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "workflow_publish_event"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });

      matrix.push({
        actual: {
          directRead: permissionEngine.projectFields(
            permissionFields,
            "direct-record-read"
          ),
          viewRead: permissionEngine.projectFields(permissionFields, "view-query"),
          workflowRead: permissionEngine.projectFields(permissionFields, "workflow-step")
        },
        category: "permissioned_reads",
        scenario: "permission_redaction_and_hidden_reads"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);

      matrix.push({
        actual: {
          field: viewPlanner.describeField("text.single_line"),
          planner: viewPlanner.describe()
        },
        category: "view_queries",
        scenario: "view_surface_capabilities"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
      const candidateRows = [
        {
          fields: [
            {
              fieldId: "title",
              fieldType: "text.single_line",
              value: "Gamma"
            },
            {
              fieldId: "health_score",
              fieldType: "computed.readonly",
              value: "20"
            }
          ],
          recordId: "rec_003",
          recordKey: "record-3"
        },
        {
          fields: [
            {
              fieldId: "title",
              fieldType: "text.single_line",
              value: "Alpha"
            },
            {
              fieldId: "health_score",
              fieldType: "computed.readonly",
              value: "10"
            }
          ],
          recordId: "rec_001",
          recordKey: "record-1"
        },
        {
          fields: [
            {
              fieldId: "title",
              fieldType: "text.single_line",
              value: ""
            },
            {
              fieldId: "health_score",
              fieldType: "computed.readonly",
              value: "5"
            }
          ],
          recordId: "rec_002",
          recordKey: "record-2"
        }
      ];
      const visibleRows = candidateRows
        .filter((row) => viewPlanner.rowMatchesFilters(row.fields, ["title"]))
        .sort((left, right) => {
          const comparison = viewPlanner.compareRows(
            left.fields,
            right.fields,
            ["health_score"]
          );
          if (comparison !== 0) {
            return comparison;
          }

          return left.recordKey.localeCompare(right.recordKey);
        });

      matrix.push({
        actual: {
          orderedRecordIds: visibleRows.map((row) => row.recordId)
        },
        category: "view_queries",
        scenario: "view_filter_and_sort_execution"
      });
    }

    {
      const action = requireAction("update_record");
      const seenCommands: CommandEnvelope[] = [];
      const executor: WorkflowActionExecutor = {
        async execute(command) {
          seenCommands.push(command);
          return buildAcceptedResult(command.commandId);
        }
      };

      const result = await executeWorkflowAction(
        action,
        {
          patch: {
            title: "Workflow patched title"
          },
          recordId: "rec_001"
        },
        {
          actor: {
            mode: "workflow",
            principalId: "wf_service"
          },
          commandId: "cmd_workflow_001",
          idempotencyKey: "wf-step-001",
          payload: {
            workflowRunId: "run_001",
            workflowStepId: "step_001"
          },
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        executor
      );

      matrix.push({
        actual: {
          result,
          seenCommands
        },
        category: "workflow_execution",
        scenario: "workflow_action_routes_through_command_envelope"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
      const commandBus = {
        execute() {
          throw new Error("not used in regression matrix");
        },
        dryRun() {
          throw new Error("not used in regression matrix");
        },
        normalizeFieldValue() {
          throw new Error("not used in regression matrix");
        }
      } as CommandBus;
      const agentToolRegistry = createAgentToolRegistry({
        commandBus,
        permissionEngine,
        viewPlanner,
        workflowHistoryReader: {
          read() {
            return {
              runs: [
                {
                  id: "wfr_matrix_001",
                  status: "dead_lettered"
                }
              ],
              workflowId: "wf_matrix"
            };
          }
        },
        workflowRunReader: {
          read() {
            return {
              id: "wfr_matrix_001",
              status: "dead_lettered",
              workflowId: "wf_matrix"
            };
          }
        },
        workflowOperatorRegistry,
        workspaceInspector: {
          async inspect() {
            return {
              apps: [],
              catalog: {
                fieldTypes: [],
                workflowOperators: []
              },
              tables: [],
              views: [],
              workflows: [],
              workspaceId: "ws_demo"
            };
          }
        }
      });
      const createFieldDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          commandId: "cmd_agent_field_001",
          fieldId: "status",
          fieldType: "single_select",
          idempotencyKey: "idem_agent_field_001",
          name: "Status",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        toolId: "createField"
      });
      const workflowHistory = await agentToolRegistry.invoke({
        input: {
          workflowId: "wf_matrix",
          workspaceId: "ws_demo"
        },
        toolId: "readWorkflowHistory"
      });
      const workflowRunDetail = await agentToolRegistry.invoke({
        input: {
          workflowRunId: "wfr_matrix_001",
          workspaceId: "ws_demo"
        },
        toolId: "readWorkflowRunDetail"
      });

      matrix.push({
        actual: {
          accessible: agentToolRegistry.listAccessible(registryFields, snapshot),
          createFieldDraft,
          dryRunTool: agentToolRegistry.require("dryRunCommand"),
          sanitizedInput: agentToolRegistry.sanitizeInput(
            "dryRunCommand",
            {
              fieldIds: ["title", "customer_note"],
              updates: [
                {
                  fieldId: "customer_note",
                  value: "hidden"
                },
                {
                  fieldId: "title",
                  value: "visible"
                }
              ],
              viewId: "view_open"
            },
            registryFields,
            snapshot
          ),
          sanitizedOutput: agentToolRegistry.sanitizeOutput(
            "dryRunCommand",
            {
              impactedFieldIds: ["title", "customer_note"],
              records: [
                {
                  fields: {
                    customer_note: "secret",
                    title: "Q3 Renewal"
                  },
                  recordId: "rec_1"
                }
              ]
            },
            registryFields,
            snapshot
          ),
          workflowHistory,
          workflowRunDetail
        },
        category: "agent_tool_dry_runs",
        scenario: "agent_tool_preview_and_sanitization"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["record.update"]
        }
      });

      const tableCommand: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_scope_table_001",
        commandType: "records.upsert",
        idempotencyKey: "idem_shared_001",
        payload: {
          patch: {
            title: "From direct user write"
          }
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };
      const workflowCommand: CommandEnvelope = {
        actor: {
          mode: "workflow",
          principalId: "usr_alice"
        },
        commandId: "cmd_scope_workflow_001",
        commandType: "records.upsert",
        idempotencyKey: "idem_shared_001",
        payload: {
          patch: {
            title: "From workflow write"
          }
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const tableResult = await commandBus.execute(tableCommand);
      const workflowResult = await commandBus.execute(workflowCommand);

      matrix.push({
        actual: {
          receiptsByScope: {
            table: eventLedger.snapshotReceipts(scopeKeyForCommand(tableCommand)),
            workflow: eventLedger.snapshotReceipts(scopeKeyForCommand(workflowCommand))
          },
          table: tableResult,
          workflow: workflowResult
        },
        category: "unsupported_command_rejection",
        scenario: "unsupported_commands_reject_without_receipts"
      });
    }

    expect(toCanonicalJson(matrix)).toMatchSnapshot();
  });
});
