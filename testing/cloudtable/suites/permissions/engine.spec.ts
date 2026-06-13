import { describe, expect, it } from "vitest";

import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type {
  EffectivePermissionSnapshot,
  PermissionEvaluationContext
} from "../../../../src/core/permissions/types";
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

const ownerMatchContext: PermissionEvaluationContext = {
  rowOwner: {
    alias: "row.owner",
    fieldId: "owner",
    fieldKey: "owner",
    fieldType: "principal.user",
    matchesPrincipal: true,
    principalIds: ["usr_alice"],
    recordId: "rec_owned"
  }
};

const ownerMismatchContext: PermissionEvaluationContext = {
  rowOwner: {
    alias: "row.owner",
    fieldId: "owner",
    fieldKey: "owner",
    fieldType: "principal.user",
    matchesPrincipal: false,
    principalIds: ["usr_bob"],
    recordId: "rec_not_owned"
  }
};

const assigneeMatchContext: PermissionEvaluationContext = {
  principalAliases: {
    "row.assignee": {
      alias: "row.assignee",
      fieldId: "assignee",
      fieldKey: "assignee",
      fieldType: "principal.user",
      matchesPrincipal: true,
      principalIds: ["usr_alice"],
      recordId: "rec_assigned"
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

  it("explains direct, view, command, workflow, and agent field access deterministically", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });

    const explanation = permissionEngine.explainFieldAccess(
      {
        fieldId: "customer_note",
        fieldType: "text.long"
      },
      [
        "direct-record-read",
        "view-query",
        "command-ingress",
        "workflow-step",
        "agent-tool"
      ],
      undefined,
      ownerMismatchContext
    );

    expect(explanation).toEqual({
      evaluationContext: ownerMismatchContext,
      fieldId: "customer_note",
      fieldType: "text.long",
      surfaces: [
        {
          allowed: true,
          evaluationContext: ownerMismatchContext,
          message: "Field value is redacted for direct record reads. Row owner does not match the current principal.",
          readState: "redacted",
          reasonMessages: ["Field value is redacted for direct record reads."],
          reasons: ["field_redacted:customer_note"],
          surface: "direct-record-read",
          writeAllowed: true
        },
        {
          allowed: true,
          evaluationContext: ownerMismatchContext,
          message: "Field value is redacted for view queries. Row owner does not match the current principal.",
          readState: "redacted",
          reasonMessages: ["Field value is redacted for view queries."],
          reasons: ["field_redacted:customer_note"],
          surface: "view-query",
          writeAllowed: true
        },
        {
          allowed: true,
          evaluationContext: ownerMismatchContext,
          message: "Field value is redacted for command writes. Row owner does not match the current principal.",
          readState: "redacted",
          reasonMessages: ["Field value is redacted for command writes."],
          reasons: ["field_redacted:customer_note"],
          surface: "command-ingress",
          writeAllowed: true
        },
        {
          allowed: true,
          evaluationContext: ownerMismatchContext,
          message: "Field value is redacted for workflow steps. Row owner does not match the current principal.",
          readState: "redacted",
          reasonMessages: ["Field value is redacted for workflow steps."],
          reasons: ["workflow_redacted:customer_note"],
          surface: "workflow-step",
          writeAllowed: true
        },
        {
          allowed: false,
          evaluationContext: ownerMismatchContext,
          message: "Field is hidden for agent tools. Row owner does not match the current principal.",
          readState: "hidden",
          reasonMessages: ["Field is hidden for agent tools."],
          reasons: ["agent_hidden:customer_note"],
          surface: "agent-tool",
          writeAllowed: false
        }
      ]
    });
  });

  it("threads canonical row owner context through field evaluation for owner matches and mismatches", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });

    const ownerMatchDecision = permissionEngine.evaluateFieldAccess(
      {
        fieldId: "title",
        fieldType: "text.single_line"
      },
      "command-ingress",
      undefined,
      ownerMatchContext
    );
    const ownerMismatchDecision = permissionEngine.evaluateFieldAccess(
      {
        fieldId: "title",
        fieldType: "text.single_line"
      },
      "command-ingress",
      undefined,
      ownerMismatchContext
    );

    expect(ownerMatchDecision.evaluationContext?.rowOwner).toEqual(ownerMatchContext.rowOwner);
    expect(ownerMismatchDecision.evaluationContext?.rowOwner).toEqual(
      ownerMismatchContext.rowOwner
    );
    expect(ownerMatchDecision.allowed).toBe(true);
    expect(ownerMismatchDecision.allowed).toBe(true);
  });

  it("includes field-declared principal aliases in explanation summaries", () => {
    const permissionEngine = createPermissionEngine(registry, {
      snapshot
    });

    const explanation = permissionEngine.explainFieldAccess(
      {
        fieldId: "title",
        fieldType: "text.single_line"
      },
      ["command-ingress"],
      undefined,
      assigneeMatchContext
    );

    expect(explanation.evaluationContext?.principalAliases?.["row.assignee"]).toEqual(
      assigneeMatchContext.principalAliases?.["row.assignee"]
    );
    expect(explanation.surfaces).toEqual([
      expect.objectContaining({
        evaluationContext: assigneeMatchContext,
        message:
          "Field can be written through commands. Principal alias row.assignee matches the current principal.",
        surface: "command-ingress"
      })
    ]);
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
      activityHistoryReader: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      appInspector: {
        inspect() {
          throw new Error("not used in permission tests");
        }
      },
      tableSchemaInspector: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      viewDefinitionInspector: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      workflowDefinitionInspector: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      permissionPersonaPreviewReader: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      commandBus,
      permissionEngine,
      recordInspector: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
      viewPlanner,
      viewQueryReader: {
        read() {
          throw new Error("not used in permission tests");
        }
      },
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
      workflowDeadLetterReplayRequester: {
        requestReplay() {
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
    const updateRecordTool = accessible.find((tool) => tool.toolId === "updateRecord");
    const archiveRecordTool = accessible.find((tool) => tool.toolId === "archiveRecord");
    const executeTool = accessible.find((tool) => tool.toolId === "executeCommand");

    expect(createViewTool).toEqual({
      allowed: true,
      hiddenFieldIds: ["customer_note"],
      reason: null,
      toolId: "createView",
      visibleFieldIds: ["health_score"]
    });
    expect(updateRecordTool).toEqual({
      allowed: false,
      hiddenFieldIds: ["customer_note"],
      reason: "agent_mutation_denied",
      toolId: "updateRecord",
      visibleFieldIds: ["health_score"]
    });
    expect(archiveRecordTool).toEqual({
      allowed: true,
      hiddenFieldIds: [],
      reason: null,
      toolId: "archiveRecord",
      visibleFieldIds: []
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
