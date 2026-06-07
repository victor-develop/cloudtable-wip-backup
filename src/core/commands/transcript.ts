import type {
  CommandEnvelope,
  CommandEvent,
  CommandReplayProjection,
  CommandResult,
  CommandSideEffect,
  IdempotencyReceipt
} from "./types";
import {
  aggregateDescriptorForCommand,
  eventTypeForCommand,
  fanoutReasonForCommand
} from "./domain";

const REQUIRED_COMMAND_FIELDS: Array<keyof CommandEnvelope> = [
  "actor",
  "commandId",
  "commandType",
  "idempotencyKey",
  "payload",
  "scope",
  "workspaceId"
];

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }

  return value;
}

export function toCanonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function hashCommand(command: CommandEnvelope): string {
  return toCanonicalJson({
    actor: command.actor,
    commandType: command.commandType,
    payload: command.payload,
    scope: command.scope,
    tableId: command.tableId,
    workspaceId: command.workspaceId
  }).trimEnd();
}

export function scopeKeyForCommand(command: CommandEnvelope): string {
  switch (command.scope) {
    case "table":
      return `${command.workspaceId}:table:${command.tableId ?? "*"}`;
    case "workflow": {
      const workflowId =
        typeof command.payload.workflowId === "string" ? command.payload.workflowId : command.commandType;
      return `${command.workspaceId}:workflow:${workflowId}`;
    }
    case "agent-tool":
      return `${command.workspaceId}:agent-tool:${command.commandType}`;
    case "workspace":
    default:
      return `${command.workspaceId}:workspace`;
  }
}

export function validateCommand(command: CommandEnvelope): string[] {
  return REQUIRED_COMMAND_FIELDS.flatMap((field) => {
    const value = command[field];
    if (value === undefined || value === null) {
      return [`missing_${field}`];
    }

    if (field === "payload" && (typeof value !== "object" || Array.isArray(value))) {
      return ["payload_must_be_object"];
    }

    if (field === "actor") {
      const diagnostics: string[] = [];
      if (!command.actor.principalId) {
        diagnostics.push("missing_actor_principalId");
      }

      if (!command.actor.mode) {
        diagnostics.push("missing_actor_mode");
      }

      return diagnostics;
    }

    return [];
  });
}

export function buildAcceptedEvent(command: CommandEnvelope, eventId: string): CommandEvent {
  const aggregate = aggregateDescriptorForCommand(command);

  return {
    ...(aggregate
      ? {
          aggregateId: aggregate.id,
          aggregateType: aggregate.type
        }
      : {}),
    commandId: command.commandId,
    commandType: command.commandType,
    eventId,
    eventType: eventTypeForCommand(command),
    tableId: command.tableId ?? null,
    workspaceId: command.workspaceId
  };
}

export function buildAcceptedSideEffects(
  command: CommandEnvelope,
  eventId: string
): CommandSideEffect[] {
  if (command.commandType === "workflow.webhook.enqueue") {
    return [];
  }

  return [
    {
      eventId,
      queue: "event-fanout",
      reason: fanoutReasonForCommand(command)
    }
  ];
}

export function toReplayProjection(
  logicalTime: string,
  receipts: IdempotencyReceipt[],
  acceptedCommandIds: string[] = []
): CommandReplayProjection {
  return {
    acceptedCommandIds,
    lastLogicalTime: logicalTime,
    receiptCount: receipts.length,
    receipts: receipts.map((receipt) => ({
      idempotencyKey: receipt.idempotencyKey,
      payloadHash: receipt.payloadHash,
      status: receipt.result.status
    }))
  };
}

export function cloneCommandResult(result: CommandResult): CommandResult {
  return structuredClone(result);
}
