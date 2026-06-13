import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import {
  evaluateWorkflowCondition,
  executeWorkflowDefinition,
  matchWorkflowTrigger
} from "../../../../src/core/workflows/execution";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import type {
  WorkflowConditionDefinition,
  WorkflowDefinition,
  WorkflowExecutionScope,
  WorkflowTriggerDefinition
} from "../../../../src/core/workflows/types";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";

function requireCondition(id: string): WorkflowConditionDefinition {
  const definition = createWorkflowOperatorRegistry().require(id);

  if (definition.kind !== "condition") {
    throw new Error(`Expected condition operator for ${id}`);
  }

  return definition;
}

function requireTrigger(id: string): WorkflowTriggerDefinition {
  const definition = createWorkflowOperatorRegistry().require(id);

  if (definition.kind !== "trigger") {
    throw new Error(`Expected trigger operator for ${id}`);
  }

  return definition;
}

function createScope(
  overrides: Partial<WorkflowExecutionScope> = {}
): WorkflowExecutionScope {
  const cell = {
    fieldId: "fld_status",
    fieldType: "text.single_line",
    recordId: "rec_source_1",
    tableId: "tbl_source",
    value: "approved"
  };

  return {
    cell,
    event: {
      commandId: "cmd_source_1",
      commandType: "cell.set",
      createdAt: "2026-06-07T00:00:00.000Z",
      eventId: "evt_source_1",
      eventType: "cell.set",
      metadata: {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        permissionScopeHash: "scope_hash",
        permissionsVersion: 7,
        schemaEpoch: 3,
        scope: "table"
      },
      payload: {
        fieldId: "fld_status",
        fieldType: "text.single_line",
        recordId: "rec_source_1",
        value: "approved"
      },
      tableId: "tbl_source",
      workspaceId: "ws_001"
    },
    relatedTables: {
      destination: {
        recordIds: ["rec_dest_1"],
        row: {
          fields: {
            owner_status: {
              fieldId: "fld_owner_status",
              fieldType: "text.single_line",
              value: "pending"
            }
          },
          recordId: "rec_dest_1"
        },
        tableId: "tbl_dest"
      }
    },
    row: {
      fields: {
        status: cell
      },
      recordId: "rec_source_1"
    },
    table: {
      fields: {
        status: {
          fieldId: "fld_status",
          fieldType: "text.single_line",
          value: "approved"
        }
      },
      row: {
        fields: {
          status: cell
        },
        recordId: "rec_source_1"
      },
      tableId: "tbl_source"
    },
    workflow: {
      triggerEventId: "evt_source_1",
      workflowId: "wf_sync_status",
      workflowRunId: "run_001"
    },
    ...overrides
  };
}

function createWorkflowDefinition(): WorkflowDefinition {
  return {
    actions: [
      {
        input: {
          fieldId: {
            path: "relatedTables.destination.row.fields.owner_status.fieldId"
          },
          fieldType: {
            path: "relatedTables.destination.row.fields.owner_status.fieldType"
          },
          recordId: {
            path: "relatedTables.destination.row.recordId"
          },
          tableId: {
            path: "relatedTables.destination.tableId"
          },
          value: {
            path: "cell.value"
          }
        },
        operatorId: "set_cell"
      }
    ],
    conditions: [
      {
        input: {
          left: {
            path: "cell.value"
          },
          right: "approved"
        },
        operatorId: "equals"
      }
    ],
    trigger: {
      match: {
        fieldIds: ["fld_status"],
        fromWorkflow: false,
        tableId: "tbl_source"
      },
      operatorId: "field_changed"
    },
    workflowId: "wf_sync_status"
  };
}

describe("workflow operator registry", () => {
  it("evaluates deterministic MVP conditions", () => {
    expect(
      evaluateWorkflowCondition(requireCondition("equals"), {
        left: "ready",
        right: "ready"
      })
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(requireCondition("number_compare"), {
        left: "42",
        right: "10",
        comparator: "gt"
      })
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(requireCondition("date_compare"), {
        left: "2026-06-06T00:00:00.000Z",
        right: "2026-06-05T00:00:00.000Z",
        comparator: "after"
      })
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(requireCondition("all"), {
        values: [true, true, false]
      })
    ).toBe(false);
  });

  it("matches field-change triggers against the stabilized cell event contract", () => {
    const definition = createWorkflowDefinition();

    expect(
      matchWorkflowTrigger(requireTrigger("field_changed"), definition.trigger, createScope())
    ).toBe(true);
    expect(
      matchWorkflowTrigger(
        requireTrigger("field_changed"),
        definition.trigger,
        createScope({
          event: {
            ...createScope().event,
            payload: {
              ...createScope().event.payload,
              fieldId: "fld_other"
            }
          }
        })
      )
    ).toBe(false);
  });

  it("keeps legacy single-field trigger selectors readable during matching", () => {
    const definition = createWorkflowDefinition();

    expect(
      matchWorkflowTrigger(
        requireTrigger("field_changed"),
        {
          ...definition.trigger,
          match: {
            ...definition.trigger.match,
            fieldId: "fld_status",
            fieldIds: undefined
          }
        },
        createScope()
      )
    ).toBe(true);
  });

  it("executes cross-table cell updates through the normal command bus", async () => {
    const workflowOperatorRegistry = createWorkflowOperatorRegistry();
    const seenCommands: CommandEnvelope[] = [];
    const commandBus = createCommandBus({
      eventLedger: new InMemoryEventLedger("2026-06-07T00:00:00.000Z"),
      fieldTypeRegistry: createFieldTypeRegistry(),
      permissionEngine: {
        describeField() {
          return {
            allowsMutation: true,
            allowsWorkflowTrigger: true,
            readRedaction: "none" as const,
            supportsValueVisibilityRules: false
          };
        },
        evaluateCommand() {
          return {
            allowed: true,
            reasons: []
          };
        },
        evaluateFieldAccess(field) {
          return {
            allowed: true,
            fieldId: field.fieldId,
            fieldType: field.fieldType,
            readState: "visible" as const,
            reasons: [],
            writeAllowed: true
          };
        },
        explainFieldAccess(field, surfaces = ["direct-record-read"]) {
          return {
            fieldId: field.fieldId,
            fieldType: field.fieldType,
            surfaces: surfaces.map((surface) => ({
              allowed: true,
              message: "Allowed.",
              readState: "visible" as const,
              reasonMessages: [],
              reasons: [],
              surface,
              writeAllowed: true
            }))
          };
        },
        filterAgentTools(tools) {
          return tools.map((tool) => ({
            allowed: true,
            hiddenFieldIds: [],
            reason: null,
            toolId: tool.id,
            visibleFieldIds: []
          }));
        },
        listSurfaces() {
          return [];
        },
        projectFields() {
          return {
            diagnostics: [],
            fields: {},
            hiddenFieldIds: [],
            redactedFieldIds: [],
            states: {}
          };
        },
        resolveAgentToolFieldVisibility() {
          return {
            hiddenFieldIds: [],
            visibleFieldIds: [],
            writableFieldIds: []
          };
        }
      },
      workflowOperatorRegistry
    });
    const executor = {
      async execute(command: CommandEnvelope) {
        seenCommands.push(command);
        return commandBus.execute(command);
      }
    };

    const result = await executeWorkflowDefinition(
      createWorkflowDefinition(),
      createScope(),
      workflowOperatorRegistry,
      executor
    );

    expect(result.matchedTrigger).toBe(true);
    if (!result.matchedTrigger) {
      throw new Error("workflow should have matched");
    }

    expect(result.conditionResults).toEqual([
      {
        operatorId: "equals",
        passed: true,
        resolvedInput: {
          left: "approved",
          right: "approved"
        }
      }
    ]);
    expect(seenCommands).toEqual([
      {
        actor: {
          mode: "workflow",
          principalId: "wf_sync_status"
        },
        commandId: "run_001:action:0",
        commandType: "cell.set",
        idempotencyKey: "run_001:action:0",
        payload: {
          fieldId: "fld_owner_status",
          fieldType: "text.single_line",
          recordId: "rec_dest_1",
          tableId: "tbl_dest",
          triggerEventId: "evt_source_1",
          value: "approved",
          workflowId: "wf_sync_status",
          workflowRunId: "run_001",
          workflowStepId: "wf_sync_status:action:0"
        },
        permissionScopeHash: "scope_hash",
        permissionsVersion: 7,
        schemaEpoch: 3,
        scope: "table",
        tableId: "tbl_dest",
        workspaceId: "ws_001"
      }
    ]);
    expect(result.executedActions).toHaveLength(1);
    expect(result.executedActions[0]?.result.status).toBe("accepted");
    expect(result.executedActions[0]?.result.events[0]?.eventType).toBe("cell.set");
  });

  it("fans out sync_related_field updates across every matched target record", async () => {
    const workflowOperatorRegistry = createWorkflowOperatorRegistry();
    const seenCommands: CommandEnvelope[] = [];

    const result = await executeWorkflowDefinition(
      {
        actions: [
          {
            input: {
              resolverAlias: "destination",
              sourceFieldId: "fld_status",
              targetFieldId: "fld_owner_status"
            },
            operatorId: "sync_related_field"
          }
        ],
        conditions: [],
        trigger: {
          match: {
            fieldId: "fld_status",
            fromWorkflow: false,
            tableId: "tbl_source"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_related_sync"
      },
      createScope({
        relatedTables: {
          destination: {
            recordIds: ["rec_dest_2", "rec_dest_1"],
            tableId: "tbl_dest"
          }
        }
      }),
      workflowOperatorRegistry,
      {
        async execute(command) {
          seenCommands.push(command);
          return {
            accepted: true,
            diagnostics: [],
            events: [],
            permission: {
              allowed: true,
              reasons: []
            },
            replayProjection: {
              acceptedCommandIds: [command.commandId],
              lastLogicalTime: "2026-06-07T00:00:00.000Z",
              receiptCount: 0,
              receipts: []
            },
            sideEffects: [],
            status: "accepted"
          };
        }
      }
    );

    expect(result.matchedTrigger).toBe(true);
    if (!result.matchedTrigger) {
      return;
    }

    expect(seenCommands).toHaveLength(2);
    expect(seenCommands.map((command) => command.payload)).toEqual([
      {
        triggerEventId: "evt_source_1",
        workflowId: "wf_related_sync",
        workflowRunId: "run_001",
        workflowStepId: "wf_related_sync:action:0",
        fieldId: "fld_owner_status",
        fieldType: "text.single_line",
        recordId: "rec_dest_1",
        tableId: "tbl_dest",
        value: "approved"
      },
      {
        triggerEventId: "evt_source_1",
        workflowId: "wf_related_sync",
        workflowRunId: "run_001",
        workflowStepId: "wf_related_sync:action:0",
        fieldId: "fld_owner_status",
        fieldType: "text.single_line",
        recordId: "rec_dest_2",
        tableId: "tbl_dest",
        value: "approved"
      }
    ]);
  });

  it("skips execution when conditions fail", async () => {
    const registry = createWorkflowOperatorRegistry();
    const executor = {
      async execute() {
        throw new Error("executor should not run when conditions fail");
      }
    };

    const result = await executeWorkflowDefinition(
      createWorkflowDefinition(),
      createScope({
        cell: {
          fieldId: "fld_status",
          fieldType: "text.single_line",
          recordId: "rec_source_1",
          tableId: "tbl_source",
          value: "pending"
        }
      }),
      registry,
      executor
    );

    expect(result).toMatchObject({
      matchedTrigger: true,
      skippedReason: "conditions_failed",
      workflowId: "wf_sync_status"
    });
  });

  it("guards against same-workflow same-cell loops and preserves command idempotency on replay", async () => {
    const registry = createWorkflowOperatorRegistry();
    const ledger = new InMemoryEventLedger("2026-06-07T00:00:00.000Z");
    const commandBus = createCommandBus({
      eventLedger: ledger,
      fieldTypeRegistry: createFieldTypeRegistry(),
      permissionEngine: {
        describeField() {
          return {
            allowsMutation: true,
            allowsWorkflowTrigger: true,
            readRedaction: "none" as const,
            supportsValueVisibilityRules: false
          };
        },
        evaluateCommand() {
          return {
            allowed: true,
            reasons: []
          };
        },
        evaluateFieldAccess(field) {
          return {
            allowed: true,
            fieldId: field.fieldId,
            fieldType: field.fieldType,
            readState: "visible" as const,
            reasons: [],
            writeAllowed: true
          };
        },
        explainFieldAccess(field, surfaces = ["direct-record-read"]) {
          return {
            fieldId: field.fieldId,
            fieldType: field.fieldType,
            surfaces: surfaces.map((surface) => ({
              allowed: true,
              message: "Allowed.",
              readState: "visible" as const,
              reasonMessages: [],
              reasons: [],
              surface,
              writeAllowed: true
            }))
          };
        },
        filterAgentTools(tools) {
          return tools.map((tool) => ({
            allowed: true,
            hiddenFieldIds: [],
            reason: null,
            toolId: tool.id,
            visibleFieldIds: []
          }));
        },
        listSurfaces() {
          return [];
        },
        projectFields() {
          return {
            diagnostics: [],
            fields: {},
            hiddenFieldIds: [],
            redactedFieldIds: [],
            states: {}
          };
        },
        resolveAgentToolFieldVisibility() {
          return {
            hiddenFieldIds: [],
            visibleFieldIds: [],
            writableFieldIds: []
          };
        }
      },
      workflowOperatorRegistry: registry
    });
    const executor = {
      async execute(command: CommandEnvelope) {
        return commandBus.execute(command);
      }
    };

    const firstRun = await executeWorkflowDefinition(
      createWorkflowDefinition(),
      createScope(),
      registry,
      executor
    );
    if (!firstRun.matchedTrigger) {
      throw new Error("workflow should have matched on first run");
    }

    expect(firstRun.executedActions[0]?.result.diagnostics).toEqual([]);

    const replayRun = await executeWorkflowDefinition(
      createWorkflowDefinition(),
      createScope(),
      registry,
      executor
    );
    if (!replayRun.matchedTrigger) {
      throw new Error("workflow should have matched on replay");
    }

    expect(replayRun.executedActions[0]?.result.diagnostics).toEqual(["idempotent_replay"]);
    expect(replayRun.executedActions[0]?.result.replayProjection.receiptCount).toBe(1);

    const loopGuardRun = await executeWorkflowDefinition(
      {
        ...createWorkflowDefinition(),
        actions: [
          {
            input: {
              fieldId: {
                path: "cell.fieldId"
              },
              fieldType: {
                path: "cell.fieldType"
              },
              recordId: {
                path: "cell.recordId"
              },
              tableId: {
                path: "cell.tableId"
              },
              value: {
                path: "cell.value"
              }
            },
            operatorId: "set_cell"
          }
        ],
        trigger: {
          match: {
            fieldId: "fld_status",
            tableId: "tbl_source"
          },
          operatorId: "field_changed"
        }
      },
      createScope({
        event: {
          ...createScope().event,
          metadata: {
            actor: {
              mode: "workflow",
              principalId: "wf_sync_status"
            },
            triggerEventId: "evt_source_1",
            workflowId: "wf_sync_status"
          }
        }
      }),
      registry,
      executor
    );
    if (!loopGuardRun.matchedTrigger) {
      throw new Error("workflow should have matched loop-guard event");
    }

    expect(loopGuardRun.executedActions[0]).toMatchObject({
      operatorId: "set_cell",
      skipped: "loop_guard"
    });
    expect(loopGuardRun.executedActions[0]?.result.diagnostics).toEqual([
      "workflow_loop_guard"
    ]);
  });

  it("resolves the canonical row.owner binding through normal workflow templates", async () => {
    const registry = createWorkflowOperatorRegistry();
    const seenCommands: CommandEnvelope[] = [];

    const result = await executeWorkflowDefinition(
      {
        actions: [
          {
            input: {
              fieldId: "fld_status",
              fieldType: "principal.user",
              recordId: "rec_source_1",
              tableId: "tbl_source",
              value: {
                path: "row.owner.value"
              }
            },
            operatorId: "set_cell"
          }
        ],
        conditions: [
          {
            input: {
              left: {
                path: "row.owner.value"
              },
              right: ["usr_owner"]
            },
            operatorId: "equals"
          }
        ],
        trigger: {
          match: {
            fieldId: "fld_status",
            tableId: "tbl_source"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_owner_binding"
      },
      createScope({
        row: {
          fields: {
            owner: {
              fieldId: "fld_owner",
              fieldType: "principal.user",
              value: ["usr_owner"]
            },
            status: {
              fieldId: "fld_status",
              fieldType: "text.single_line",
              value: "approved"
            }
          },
          owner: {
            fieldId: "fld_owner",
            fieldType: "principal.user",
            value: ["usr_owner"]
          },
          recordId: "rec_source_1"
        }
      }),
      registry,
      {
        async execute(command) {
          seenCommands.push(command);
          return {
            accepted: true,
            diagnostics: [],
            events: [],
            permission: {
              allowed: true,
              reasons: []
            },
            replayProjection: {
              acceptedCommandIds: [],
              lastLogicalTime: "2026-06-07T00:00:00.000Z",
              receiptCount: 0,
              receipts: []
            },
            sideEffects: [],
            status: "accepted" as const
          };
        }
      }
    );

    expect(result).toMatchObject({
      matchedTrigger: true
    });
    expect(seenCommands).toHaveLength(1);
    expect(seenCommands[0]?.payload.value).toEqual(["usr_owner"]);
  });
});
