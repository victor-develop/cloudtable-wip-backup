import { describe, expect, it } from "vitest";

import type { CommandEnvelope, CommandResult } from "../../../../src/core/commands/types";
import { executeWorkflowAction, evaluateWorkflowCondition } from "../../../../src/core/workflows/execution";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import type {
  WorkflowActionDefinition,
  WorkflowActionExecutor,
  WorkflowConditionDefinition
} from "../../../../src/core/workflows/types";

function requireCondition(id: string): WorkflowConditionDefinition {
  const definition = createWorkflowOperatorRegistry().require(id);

  if (definition.kind !== "condition") {
    throw new Error(`Expected condition operator for ${id}`);
  }

  return definition;
}

function requireAction(id: string): WorkflowActionDefinition {
  const definition = createWorkflowOperatorRegistry().require(id);

  if (definition.kind !== "action") {
    throw new Error(`Expected action operator for ${id}`);
  }

  return definition;
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

  it("routes workflow actions through the normal command envelope", async () => {
    const action = requireAction("update_record");
    const seenCommands: CommandEnvelope[] = [];
    const executor: WorkflowActionExecutor = {
      async execute(command): Promise<CommandResult> {
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
            lastLogicalTime: "2026-06-06T00:00:00.000Z",
            receiptCount: 1,
            receipts: []
          },
          sideEffects: [],
          status: "accepted"
        };
      }
    };

    const result = await executeWorkflowAction(
      action,
      {
        recordId: "rec_001",
        patch: {
          title: "Updated title"
        }
      },
      {
        actor: {
          principalId: "wf_service",
          mode: "workflow"
        },
        commandId: "cmd_0001",
        idempotencyKey: "wf-step-0001",
        payload: {
          workflowRunId: "run_001",
          workflowStepId: "step_001"
        },
        permissionsVersion: 7,
        permissionScopeHash: "scope_hash",
        schemaEpoch: 3,
        tableId: "tbl_001",
        workspaceId: "ws_001"
      },
      executor
    );

    expect(result.status).toBe("accepted");
    expect(seenCommands).toEqual([
      {
        actor: {
          principalId: "wf_service",
          mode: "workflow"
        },
        commandId: "cmd_0001",
        commandType: "record.update",
        idempotencyKey: "wf-step-0001",
        payload: {
          workflowRunId: "run_001",
          workflowStepId: "step_001",
          recordId: "rec_001",
          patch: {
            title: "Updated title"
          }
        },
        permissionScopeHash: "scope_hash",
        permissionsVersion: 7,
        schemaEpoch: 3,
        scope: "workflow",
        tableId: "tbl_001",
        workspaceId: "ws_001"
      }
    ]);
  });

  it("preserves permission rejection from the command path", async () => {
    const action = requireAction("archive_record");
    const executor: WorkflowActionExecutor = {
      async execute(): Promise<CommandResult> {
        return {
          accepted: false,
          diagnostics: ["permission_denied"],
          events: [],
          permission: {
            allowed: false,
            reasons: ["workflow principal cannot archive this record"]
          },
          replayProjection: {
            acceptedCommandIds: [],
            lastLogicalTime: "2026-06-06T00:00:00.000Z",
            receiptCount: 0,
            receipts: []
          },
          sideEffects: [],
          status: "rejected"
        };
      }
    };

    const result = await executeWorkflowAction(
      action,
      {
        recordId: "rec_001"
      },
      {
        actor: {
          principalId: "wf_service",
          mode: "workflow"
        },
        commandId: "cmd_0002",
        idempotencyKey: "wf-step-0002",
        payload: {},
        workspaceId: "ws_001"
      },
      executor
    );

    expect(result).toEqual({
      accepted: false,
      diagnostics: ["permission_denied"],
      events: [],
      permission: {
        allowed: false,
        reasons: ["workflow principal cannot archive this record"]
      },
      replayProjection: {
        acceptedCommandIds: [],
        lastLogicalTime: "2026-06-06T00:00:00.000Z",
        receiptCount: 0,
        receipts: []
      },
      sideEffects: [],
      status: "rejected"
    });
  });
});
