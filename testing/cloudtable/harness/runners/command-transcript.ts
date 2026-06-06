import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { createDeterministicRuntime } from "../runtime/deterministic-runtime";
import type {
  CommandFixture,
  CommandProjection,
  CommandTranscriptResult,
  PermissionExpectation,
  SeedReceipt
} from "../fixtures/command-fixture";
import { toCanonicalJson } from "../serializers/canonical-json";

type ReceiptProjection = {
  acceptedCommandIds: string[];
  lastLogicalTime: string;
  receipts: SeedReceipt[];
};

const REQUIRED_COMMAND_FIELDS: Array<keyof CommandEnvelope> = [
  "actor",
  "commandId",
  "commandType",
  "idempotencyKey",
  "payload",
  "scope",
  "workspaceId"
];

function hashCommand(command: CommandEnvelope): string {
  return toCanonicalJson({
    actor: command.actor,
    commandType: command.commandType,
    payload: command.payload,
    scope: command.scope,
    tableId: command.tableId,
    workspaceId: command.workspaceId
  }).trimEnd();
}

function toProjection(state: ReceiptProjection): CommandProjection {
  return {
    acceptedCommandIds: state.acceptedCommandIds,
    lastLogicalTime: state.lastLogicalTime,
    receiptCount: state.receipts.length,
    receipts: state.receipts.map((receipt) => ({
      idempotencyKey: receipt.idempotencyKey,
      payloadHash: receipt.payloadHash,
      status: receipt.result.status
    }))
  };
}

function validateCommand(command: CommandEnvelope): string[] {
  return REQUIRED_COMMAND_FIELDS.flatMap((field) => {
    const value = command[field];
    if (value === undefined || value === null) {
      return [`missing_${field}`];
    }

    if (field === "payload" && (typeof value !== "object" || Array.isArray(value))) {
      return ["payload_must_be_object"];
    }

    if (field === "actor") {
      const actor = value as CommandEnvelope["actor"];
      const diagnostics: string[] = [];

      if (!actor.principalId) {
        diagnostics.push("missing_actor_principalId");
      }

      if (!actor.mode) {
        diagnostics.push("missing_actor_mode");
      }

      return diagnostics;
    }

    return [];
  });
}

function buildAcceptedResult(
  command: CommandEnvelope,
  permission: PermissionExpectation,
  logicalTime: string
): Omit<CommandTranscriptResult, "replayProjection"> {
  const runtime = createDeterministicRuntime(1);
  const eventId = runtime.nextId("evt");

  return {
    accepted: true,
    diagnostics: [],
    events: [
      {
        commandId: command.commandId,
        commandType: command.commandType,
        eventId,
        eventType: "scaffold.command.accepted",
        tableId: command.tableId ?? null,
        workspaceId: command.workspaceId
      }
    ],
    permission,
    sideEffects: [
      {
        eventId,
        queue: "event-fanout",
        reason: "placeholder"
      }
    ],
    status: "accepted"
  };
}

function replayProjectionFromEvents(
  logicalTime: string,
  seedReceipts: SeedReceipt[],
  events: Array<Record<string, unknown>>,
  command: CommandEnvelope
): CommandProjection {
  const state: ReceiptProjection = {
    acceptedCommandIds: [],
    lastLogicalTime: logicalTime,
    receipts: seedReceipts.map((receipt) => ({
      ...receipt,
      result: {
        ...receipt.result,
        events: receipt.result.events.map((event) => ({ ...event })),
        permission: {
          ...receipt.result.permission,
          reasons: [...receipt.result.permission.reasons]
        },
        replayProjection: receipt.result.replayProjection,
        sideEffects: receipt.result.sideEffects.map((effect) => ({ ...effect }))
      }
    }))
  };

  if (events.length > 0) {
    state.acceptedCommandIds.push(command.commandId);
    state.receipts.push({
      idempotencyKey: command.idempotencyKey,
      payloadHash: hashCommand(command),
      result: {
        accepted: true,
        diagnostics: [],
        events,
        permission: {
          allowed: true,
          reasons: []
        },
        replayProjection: {
          acceptedCommandIds: [],
          lastLogicalTime: logicalTime,
          receiptCount: 0,
          receipts: []
        },
        sideEffects: [
          {
            eventId: events[0]?.eventId,
            queue: "event-fanout",
            reason: "placeholder"
          }
        ],
        status: "accepted"
      }
    });
  }

  return toProjection(state);
}

export function executeCommandFixture(fixture: CommandFixture): CommandTranscriptResult {
  const diagnostics = validateCommand(fixture.command);

  if (diagnostics.length > 0) {
    return {
      accepted: false,
      diagnostics,
      events: [],
      permission: {
        allowed: false,
        reasons: []
      },
      replayProjection: toProjection({
        acceptedCommandIds: [],
        lastLogicalTime: fixture.meta.logicalStartTime,
        receipts: fixture.seedState.receipts ?? []
      }),
      sideEffects: [],
      status: "rejected"
    };
  }

  const permission: PermissionExpectation = fixture.seedState.permission ?? {
    allowed: true,
    reasons: []
  };

  if (!permission.allowed) {
    return {
      accepted: false,
      diagnostics: [...permission.reasons],
      events: [],
      permission,
      replayProjection: toProjection({
        acceptedCommandIds: [],
        lastLogicalTime: fixture.meta.logicalStartTime,
        receipts: fixture.seedState.receipts ?? []
      }),
      sideEffects: [],
      status: "rejected"
    };
  }

  const payloadHash = hashCommand(fixture.command);
  const matchedReceipt = (fixture.seedState.receipts ?? []).find(
    (receipt) => receipt.idempotencyKey === fixture.command.idempotencyKey
  );

  if (matchedReceipt) {
    if (matchedReceipt.payloadHash !== payloadHash) {
      return {
        accepted: false,
        diagnostics: ["idempotency_key_conflict"],
        events: [],
        permission,
        replayProjection: toProjection({
          acceptedCommandIds: [],
          lastLogicalTime: fixture.meta.logicalStartTime,
          receipts: fixture.seedState.receipts ?? []
        }),
        sideEffects: [],
        status: "rejected"
      };
    }

    return {
      ...matchedReceipt.result,
      diagnostics: ["idempotent_replay"],
      permission,
      replayProjection: toProjection({
        acceptedCommandIds: [],
        lastLogicalTime: fixture.meta.logicalStartTime,
        receipts: fixture.seedState.receipts ?? []
      })
    };
  }

  const accepted = buildAcceptedResult(fixture.command, permission, fixture.meta.logicalStartTime);
  return {
    ...accepted,
    replayProjection: replayProjectionFromEvents(
      fixture.meta.logicalStartTime,
      fixture.seedState.receipts ?? [],
      accepted.events,
      fixture.command
    )
  };
}
