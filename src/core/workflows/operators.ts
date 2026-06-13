import type {
  WorkflowActionDefinition,
  WorkflowActionExecutionContext,
  WorkflowActionExecutor,
  WorkflowExecutionScope,
  WorkflowOperatorCapability,
  WorkflowConditionDefinition,
  WorkflowOperatorDefinition,
  WorkflowTriggerDefinition
} from "./types";
import type { CommandResult } from "../commands/types";

function stableEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEmptyValue(value: unknown): boolean {
  return (
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function coerceDateStamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function coerceText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function createActionCommand(
  scope: "workspace" | "table" | "workflow" | "agent-tool",
  commandType: string,
  input: Record<string, unknown>,
  context: WorkflowActionExecutionContext
) {
  return {
    commandId: context.commandId,
    workspaceId: context.workspaceId,
    tableId: context.tableId,
    scope,
    commandType,
    actor: context.actor,
    permissionsVersion: context.permissionsVersion,
    permissionScopeHash: context.permissionScopeHash,
    schemaEpoch: context.schemaEpoch,
    idempotencyKey: context.idempotencyKey,
    payload: {
      ...context.payload,
      ...input
    }
  };
}

function defineTrigger(
  id: string,
  triggerEventTypes: readonly string[]
): WorkflowTriggerDefinition {
  return {
    id,
    kind: "trigger",
    version: 1,
    triggerEventTypes,
    inputSchema: {
      type: "object",
      description: "Workflow trigger input envelope."
    },
    outputSchema: {
      type: "object",
      description: "Normalized workflow trigger context."
    },
    requiredCapabilities: ["workflows.execute"],
    purity: "pure",
    idempotencyMode: "deterministic",
    timeoutClass: "fast",
    retryClass: "none",
    fixtureContract: []
  };
}

function defineCondition(
  input: Omit<
    WorkflowConditionDefinition,
    | "kind"
    | "version"
    | "inputSchema"
    | "outputSchema"
    | "requiredCapabilities"
    | "purity"
    | "idempotencyMode"
    | "timeoutClass"
    | "retryClass"
  >
): WorkflowConditionDefinition {
  return {
    ...input,
    kind: "condition",
    version: 1,
    inputSchema: {
      type: "object",
      description: `Inputs for ${input.id}.`
    },
    outputSchema: {
      type: "boolean",
      description: `Boolean result for ${input.id}.`
    },
    requiredCapabilities: ["fields.read"],
    purity: "pure",
    idempotencyMode: "deterministic",
    timeoutClass: "fast",
    retryClass: "none"
  };
}

function defineAction(
  id: string,
  commandType: string,
  requiredCapabilities: readonly WorkflowOperatorCapability[],
  fixturePayload: Record<string, unknown>,
  commandScope: "workspace" | "table" | "workflow" | "agent-tool" = "workflow"
): WorkflowActionDefinition {
  return {
    id,
    kind: "action",
    version: 1,
    commandType,
    inputSchema: {
      type: "object",
      description: `Inputs for ${id}.`
    },
    outputSchema: {
      type: "object",
      description: "Command result emitted through the normal command bus."
    },
    requiredCapabilities,
    purity: "impure",
    idempotencyMode: "command_idempotency_key",
    timeoutClass: commandType === "workflow.webhook.enqueue" ? "network" : "standard",
    retryClass: commandType === "workflow.webhook.enqueue" ? "network" : "standard",
    commandScope,
    proposalTemplate: fixturePayload,
    createCommand(input, context) {
      return createActionCommand(commandScope, commandType, input, context);
    },
    fixtureContract: [
      {
        id: `${id}.action.sample`,
        kind: "action",
        input: fixturePayload,
        expectedCommandType: commandType,
        expectedPayload: fixturePayload
      }
    ]
  };
}

function mergeWorkflowActionResults(results: readonly CommandResult[]): CommandResult {
  const lastReplayProjection = results.at(-1)?.replayProjection;

  return {
    accepted: results.every((result) => result.accepted),
    diagnostics: results.flatMap((result) => result.diagnostics),
    events: results.flatMap((result) => result.events),
    permission: {
      allowed: results.every((result) => result.permission.allowed),
      reasons: Array.from(new Set(results.flatMap((result) => result.permission.reasons)))
    },
    replayProjection: {
      acceptedCommandIds: results.flatMap((result) => result.replayProjection.acceptedCommandIds),
      lastLogicalTime: lastReplayProjection?.lastLogicalTime ?? new Date(0).toISOString(),
      receiptCount: results.reduce(
        (count, result) => count + result.replayProjection.receiptCount,
        0
      ),
      receipts: results.flatMap((result) => result.replayProjection.receipts)
    },
    sideEffects: results.flatMap((result) => result.sideEffects),
    status: results.every((result) => result.status === "accepted") ? "accepted" : "rejected"
  };
}

function rejectWorkflowAction(diagnostic: string): CommandResult {
  return {
    accepted: false,
    diagnostics: [diagnostic],
    events: [],
    permission: {
      allowed: true,
      reasons: []
    },
    replayProjection: {
      acceptedCommandIds: [],
      lastLogicalTime: new Date(0).toISOString(),
      receiptCount: 0,
      receipts: []
    },
    sideEffects: [],
    status: "rejected"
  };
}

async function executeSyncRelatedFieldAction(
  input: Record<string, unknown>,
  context: WorkflowActionExecutionContext,
  scope: WorkflowExecutionScope,
  executor: WorkflowActionExecutor
): Promise<CommandResult> {
  const resolverAlias =
    typeof input.resolverAlias === "string" && input.resolverAlias.length > 0
      ? input.resolverAlias
      : null;
  const sourceFieldId =
    typeof input.sourceFieldId === "string" && input.sourceFieldId.length > 0
      ? input.sourceFieldId
      : null;
  const targetFieldId =
    typeof input.targetFieldId === "string" && input.targetFieldId.length > 0
      ? input.targetFieldId
      : null;

  if (!resolverAlias || !sourceFieldId || !targetFieldId) {
    return rejectWorkflowAction("workflow_sync_action_input_invalid");
  }

  const relatedTable = scope.relatedTables?.[resolverAlias];
  if (!relatedTable) {
    return rejectWorkflowAction(`workflow_sync_action_resolver_missing:${resolverAlias}`);
  }

  const sourceField = Object.values(scope.row?.fields ?? {}).find(
    (field) => field.fieldId === sourceFieldId
  );
  if (!sourceField) {
    return rejectWorkflowAction(
      `workflow_sync_action_source_field_missing:${resolverAlias}:${sourceFieldId}`
    );
  }

  const targetRecordIds = Array.from(
    new Set(
      (relatedTable.recordIds ?? []).filter(
        (recordId): recordId is string => typeof recordId === "string" && recordId.length > 0
      )
    )
  ).sort();

  if (targetRecordIds.length === 0) {
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
        lastLogicalTime: new Date(0).toISOString(),
        receiptCount: 0,
        receipts: []
      },
      sideEffects: [],
      status: "accepted"
    };
  }

  const results: CommandResult[] = [];
  for (const recordId of targetRecordIds) {
    const result = await executor.execute({
      ...context,
      commandId: `${context.commandId}:${recordId}`,
      idempotencyKey: `${context.idempotencyKey}:${recordId}`,
      payload: {
        ...context.payload,
        fieldId: targetFieldId,
        recordId,
        tableId: relatedTable.tableId,
        value: sourceField.value
      },
      tableId: relatedTable.tableId,
      workspaceId: context.workspaceId,
      scope: "table",
      commandType: "cell.set",
      actor: context.actor
    });
    results.push(result);
    if (!result.accepted) {
      break;
    }
  }

  return mergeWorkflowActionResults(results);
}

const conditionOperators: readonly WorkflowConditionDefinition[] = [
  defineCondition({
    id: "equals",
    evaluate(input) {
      return stableEquals(input.left, input.right);
    },
    fixtureContract: [
      {
        id: "equals.condition.sample",
        kind: "condition",
        input: {
          left: "ready",
          right: "ready"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "not_equals",
    evaluate(input) {
      return !stableEquals(input.left, input.right);
    },
    fixtureContract: [
      {
        id: "not_equals.condition.sample",
        kind: "condition",
        input: {
          left: "ready",
          right: "blocked"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "is_empty",
    evaluate(input) {
      return isEmptyValue(input.value);
    },
    fixtureContract: [
      {
        id: "is_empty.condition.sample",
        kind: "condition",
        input: {
          value: ""
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "is_not_empty",
    evaluate(input) {
      return !isEmptyValue(input.value);
    },
    fixtureContract: [
      {
        id: "is_not_empty.condition.sample",
        kind: "condition",
        input: {
          value: "alpha"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "text_contains",
    evaluate(input) {
      return coerceText(input.value).toLowerCase().includes(coerceText(input.query).toLowerCase());
    },
    fixtureContract: [
      {
        id: "text_contains.condition.sample",
        kind: "condition",
        input: {
          value: "Alpha Bravo",
          query: "bravo"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "text_starts_with",
    evaluate(input) {
      return coerceText(input.value)
        .toLowerCase()
        .startsWith(coerceText(input.prefix).toLowerCase());
    },
    fixtureContract: [
      {
        id: "text_starts_with.condition.sample",
        kind: "condition",
        input: {
          value: "Alpha Bravo",
          prefix: "alpha"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "number_compare",
    evaluate(input) {
      const left = coerceNumber(input.left);
      const right = coerceNumber(input.right);
      const comparator = input.comparator;

      if (left == null || right == null || typeof comparator !== "string") {
        return false;
      }

      switch (comparator) {
        case "eq":
          return left === right;
        case "neq":
          return left !== right;
        case "gt":
          return left > right;
        case "gte":
          return left >= right;
        case "lt":
          return left < right;
        case "lte":
          return left <= right;
        default:
          return false;
      }
    },
    fixtureContract: [
      {
        id: "number_compare.condition.sample",
        kind: "condition",
        input: {
          left: "42.5",
          right: "40",
          comparator: "gt"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "date_compare",
    evaluate(input) {
      const left = coerceDateStamp(input.left);
      const right = coerceDateStamp(input.right);
      const comparator = input.comparator;

      if (left == null || right == null || typeof comparator !== "string") {
        return false;
      }

      switch (comparator) {
        case "before":
          return left < right;
        case "after":
          return left > right;
        case "on_or_before":
          return left <= right;
        case "on_or_after":
          return left >= right;
        default:
          return false;
      }
    },
    fixtureContract: [
      {
        id: "date_compare.condition.sample",
        kind: "condition",
        input: {
          left: "2026-06-06T00:00:00.000Z",
          right: "2026-06-07T00:00:00.000Z",
          comparator: "before"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "select_has_option",
    evaluate(input) {
      return Array.isArray(input.value) && input.value.some((value) => stableEquals(value, input.option));
    },
    fixtureContract: [
      {
        id: "select_has_option.condition.sample",
        kind: "condition",
        input: {
          value: ["alpha", "beta"],
          option: "beta"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "relation_contains_record",
    evaluate(input) {
      return Array.isArray(input.value) && input.value.some((value) => stableEquals(value, input.recordId));
    },
    fixtureContract: [
      {
        id: "relation_contains_record.condition.sample",
        kind: "condition",
        input: {
          value: ["rec_001", "rec_002"],
          recordId: "rec_002"
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "all",
    evaluate(input) {
      return Array.isArray(input.values) && input.values.every((value) => Boolean(value));
    },
    fixtureContract: [
      {
        id: "all.condition.sample",
        kind: "condition",
        input: {
          values: [true, true, true]
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "any",
    evaluate(input) {
      return Array.isArray(input.values) && input.values.some((value) => Boolean(value));
    },
    fixtureContract: [
      {
        id: "any.condition.sample",
        kind: "condition",
        input: {
          values: [false, true, false]
        },
        expected: true
      }
    ]
  }),
  defineCondition({
    id: "not",
    evaluate(input) {
      return !Boolean(input.value);
    },
    fixtureContract: [
      {
        id: "not.condition.sample",
        kind: "condition",
        input: {
          value: false
        },
        expected: true
      }
    ]
  })
];

export const mvpWorkflowOperators: readonly WorkflowOperatorDefinition[] = [
  defineTrigger("record_created", ["record.created"]),
  defineTrigger("record_updated", ["record.updated"]),
  defineTrigger("field_changed", ["cell.set"]),
  defineTrigger("scheduled", ["workflow.scheduled"]),
  defineTrigger("manual", ["workflow.manual"]),
  ...conditionOperators,
  defineAction("create_record", "record.create", ["records.write"], {
    record: {
      title: "Alpha"
    }
  }, "table"),
  defineAction("set_cell", "cell.set", ["records.write"], {
    fieldId: "fld_title",
    fieldType: "text.single_line",
    recordId: "rec_001",
    tableId: "tbl_tasks",
    value: "Bravo"
  }, "table"),
  {
    id: "sync_related_field",
    kind: "action",
    version: 1,
    commandType: "cell.set",
    commandScope: "table",
    inputSchema: {
      type: "object",
      description: "Copy one source field value into the matching related target rows."
    },
    outputSchema: {
      type: "object",
      description: "Aggregated command result for the emitted target cell updates."
    },
    requiredCapabilities: ["records.read", "records.write"],
    purity: "impure",
    idempotencyMode: "command_idempotency_key",
    timeoutClass: "standard",
    retryClass: "standard",
    proposalTemplate: {
      resolverAlias: "account",
      sourceFieldId: "fld_status",
      targetFieldId: "fld_account_status"
    },
    createCommand(input, context) {
      return createActionCommand("table", "cell.set", input, context);
    },
    execute(input, context, scope, executor) {
      return executeSyncRelatedFieldAction(input, context, scope, executor);
    },
    fixtureContract: [
      {
        id: "sync_related_field.action.sample",
        kind: "action",
        input: {
          resolverAlias: "account",
          sourceFieldId: "fld_status",
          targetFieldId: "fld_account_status"
        },
        expectedCommandType: "cell.set",
        expectedPayload: {
          resolverAlias: "account",
          sourceFieldId: "fld_status",
          targetFieldId: "fld_account_status"
        }
      }
    ]
  },
  defineAction("update_record", "record.update", ["records.write"], {
    recordId: "rec_001",
    patch: {
      title: "Bravo"
    }
  }, "table"),
  defineAction("archive_record", "record.archive", ["records.write"], {
    recordId: "rec_001"
  }, "table"),
  defineAction("send_webhook", "workflow.webhook.enqueue", ["webhooks.deliver"], {
    destination: "https://example.test/hooks/cloudtable",
    body: {
      event: "record.updated"
    }
  }),
  defineAction("enqueue_internal_job", "job.enqueue", ["jobs.enqueue"], {
    jobType: "projection.rebuild",
    args: {
      recordId: "rec_001"
    }
  }),
  defineAction("emit_notification_event", "notification.emit", ["notifications.emit"], {
    channel: "activity",
    message: "Workflow step completed."
  })
];
