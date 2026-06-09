import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { validateDomainCommand } from "../../../../src/core/commands/domain";
import {
  buildAcceptedEvent,
  buildAcceptedSideEffects,
  hashCommand,
  validateCommand
} from "../../../../src/core/commands/transcript";
import { createDeterministicRuntime } from "../runtime/deterministic-runtime";
import type {
  CommandFixture,
  CommandProjection,
  CommandTranscriptResult,
  PermissionExpectation,
  SeedReceipt
} from "../fixtures/command-fixture";
import { toCanonicalJson } from "../serializers/canonical-json";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

type ReceiptProjection = {
  acceptedCommandIds: string[];
  lastLogicalTime: string;
  receipts: SeedReceipt[];
};

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

function buildAcceptedResult(
  command: CommandEnvelope,
  permission: PermissionExpectation,
  logicalTime: string
): Omit<CommandTranscriptResult, "replayProjection"> {
  const runtime = createDeterministicRuntime(1);
  const eventId = runtime.nextId("evt");
  const event = buildAcceptedEvent(command, eventId);

  return {
    accepted: true,
    diagnostics: [],
    events: [event],
    permission,
    sideEffects: buildAcceptedSideEffects(command, eventId),
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
        sideEffects: buildAcceptedSideEffects(command, String(events[0]?.eventId ?? "")),
        status: "accepted"
      }
    });
  }

  return toProjection(state);
}

export function executeCommandFixture(fixture: CommandFixture): CommandTranscriptResult {
  const diagnostics = [
    ...validateCommand(fixture.command),
    ...validateDomainCommand(
      fixture.command,
      fieldTypeRegistry,
      workflowOperatorRegistry
    )
  ];

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
