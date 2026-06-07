import { describe, expect, it } from "vitest";

import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { createViewPlanner } from "../../../../src/core/views/planner";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";

const registry = createFieldTypeRegistry();

const snapshot: EffectivePermissionSnapshot = {
  snapshotId: "snap_001",
  workspaceId: "ws_demo",
  principalId: "usr_alice",
  policyRevision: 7,
  schemaEpoch: 3,
  scopeHash: "scope:table:tbl_tasks",
  commandTypes: ["record.create", "record.update", "record.read"],
  fields: {
    title: {
      fieldId: "title",
      fieldType: "text.single_line",
      read: "visible",
      write: true,
      workflow: true,
      agent: true
    },
    salary: {
      fieldId: "salary",
      fieldType: "number.decimal",
      read: "hidden",
      write: false,
      workflow: false,
      agent: false
    },
    customer_note: {
      fieldId: "customer_note",
      fieldType: "text.long",
      read: "redacted",
      write: true,
      workflow: true,
      agent: false
    },
    internal_note: {
      fieldId: "internal_note",
      fieldType: "text.long",
      read: "visible",
      write: true,
      workflow: false,
      agent: true
    },
    health_score: {
      fieldId: "health_score",
      fieldType: "computed.readonly",
      read: "visible",
      write: false,
      workflow: true,
      agent: true
    }
  }
};

function buildCommand(
  overrides: Partial<CommandEnvelope> = {},
  fieldEdits: Array<{ fieldId: string; fieldType: string; value?: unknown }> = []
): CommandEnvelope {
  return {
    actor: {
      mode: "user",
      principalId: "usr_alice"
    },
    commandId: "cmd_001",
    commandType: "record.update",
    idempotencyKey: "idem_001",
    payload: {
      fieldEdits
    },
    permissionScopeHash: snapshot.scopeHash,
    permissionsVersion: snapshot.policyRevision,
    schemaEpoch: snapshot.schemaEpoch,
    scope: "table",
    tableId: "tbl_tasks",
    workspaceId: "ws_demo",
    ...overrides
  };
}

describe("cloudtable permission engine", () => {
  it("projects hidden, read-only, and redacted fields deterministically", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });

    const projection = permissionEngine.projectFields(
      [
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
          fieldId: "health_score",
          fieldType: "computed.readonly",
          value: "green"
        }
      ],
      "direct-record-read"
    );

    expect(projection.fields).toEqual({
      customer_note: "[redacted]",
      health_score: "green",
      title: "Q3 Renewal"
    });
    expect(projection.states).toEqual({
      customer_note: "redacted",
      health_score: "visible",
      salary: "hidden",
      title: "visible"
    });
    expect(projection.hiddenFieldIds).toEqual(["salary"]);
    expect(projection.redactedFieldIds).toEqual(["customer_note"]);
  });

  it("hides workflow-blocked fields from workflow context while keeping direct reads intact", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });

    const directProjection = permissionEngine.projectFields(
      [
        {
          fieldId: "internal_note",
          fieldType: "text.long",
          value: "Only humans should see this in workflows"
        }
      ],
      "direct-record-read"
    );
    const workflowProjection = permissionEngine.projectFields(
      [
        {
          fieldId: "internal_note",
          fieldType: "text.long",
          value: "Only humans should see this in workflows"
        }
      ],
      "workflow-step"
    );

    expect(directProjection.fields.internal_note).toBe(
      "Only humans should see this in workflows"
    );
    expect(workflowProjection.fields).toEqual({});
    expect(workflowProjection.hiddenFieldIds).toEqual(["internal_note"]);
    expect(workflowProjection.diagnostics).toContain("workflow_hidden:internal_note");
  });

  it("rejects read-only, stale, workflow-hidden, and agent-hidden mutations", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });

    const staleDecision = permissionEngine.evaluateCommand(
      buildCommand(
        {
          permissionsVersion: 6
        },
        [
          {
            fieldId: "title",
            fieldType: "text.single_line",
            value: "Changed"
          }
        ]
      )
    );
    const readOnlyDecision = permissionEngine.evaluateCommand(
      buildCommand(
        {},
        [
          {
            fieldId: "health_score",
            fieldType: "computed.readonly",
            value: "red"
          }
        ]
      )
    );
    const workflowDecision = permissionEngine.evaluateCommand(
      buildCommand(
        {
          actor: {
            mode: "workflow",
            principalId: "usr_alice"
          }
        },
        [
          {
            fieldId: "internal_note",
            fieldType: "text.long",
            value: "Attempted workflow write"
          }
        ]
      )
    );
    const agentDecision = permissionEngine.evaluateCommand(
      buildCommand(
        {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          }
        },
        [
          {
            fieldId: "customer_note",
            fieldType: "text.long",
            value: "Attempted agent write"
          }
        ]
      )
    );
    const createDecision = permissionEngine.evaluateCommand(
      buildCommand({
        actor: {
          mode: "agent",
          principalId: "usr_alice"
        },
        commandType: "record.create",
        payload: {
          cells: {
            customer_note: "Attempted agent create write",
            title: "Acme"
          },
          recordId: "rec_001"
        }
      })
    );

    expect(staleDecision).toEqual({
      allowed: false,
      reasons: ["permission_stale"]
    });
    expect(readOnlyDecision.allowed).toBe(false);
    expect(readOnlyDecision.reasons).toContain("field_read_only:health_score");
    expect(workflowDecision.allowed).toBe(false);
    expect(workflowDecision.reasons).toContain("workflow_hidden:internal_note");
    expect(agentDecision.allowed).toBe(false);
    expect(agentDecision.reasons).toContain("agent_hidden:customer_note");
    expect(createDecision.allowed).toBe(false);
    expect(createDecision.reasons).toContain("agent_hidden:customer_note");
  });

  it("filters agent tools against visible writable fields", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });
    const viewPlanner = createViewPlanner(registry, permissionEngine);
    const commandBus = {
      dryRun() {
        throw new Error("not used in permission tests");
      },
      execute() {
        throw new Error("not used in permission tests");
      },
      normalizeFieldValue() {
        throw new Error("not used in permission tests");
      }
    } as CommandBus;
    const agentToolRegistry = createAgentToolRegistry({
      commandBus,
      permissionEngine,
      viewPlanner,
      workflowHistoryReader: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      workflowRunReader: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      workflowOperatorRegistry: createWorkflowOperatorRegistry(),
      workspaceInspector: {
        inspect() {
          return {
            apps: [],
            tables: [],
            views: [],
            workflows: [],
            workspaceId: snapshot.workspaceId
          };
        }
      }
    });

    const accessible = agentToolRegistry.listAccessible(
      [
        {
          fieldId: "customer_note",
          fieldType: "text.long"
        },
        {
          fieldId: "health_score",
          fieldType: "computed.readonly"
        }
      ],
      snapshot
    );

    const createViewTool = accessible.find((tool) => tool.toolId === "createView");
    const executeTool = accessible.find((tool) => tool.toolId === "executeCommand");

    expect(createViewTool).toEqual({
      allowed: true,
      hiddenFieldIds: ["customer_note"],
      reason: null,
      toolId: "createView",
      visibleFieldIds: ["health_score"]
    });
    expect(executeTool).toEqual({
      allowed: true,
      hiddenFieldIds: [],
      reason: null,
      toolId: "executeCommand",
      visibleFieldIds: []
    });
  });
});
