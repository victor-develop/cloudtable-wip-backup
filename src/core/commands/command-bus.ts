import type { FieldTypeRegistry } from "../field-types/types";
import type { PermissionEngine } from "../permissions/types";
import type { WorkflowOperatorRegistry } from "../workflows/types";
import type { EventLedger } from "../events/types";
import {
  buildAcceptedEvent,
  buildAcceptedSideEffects,
  cloneCommandResult,
  hashCommand,
  scopeKeyForCommand,
  toReplayProjection,
  validateCommand
} from "./transcript";
import type { CommandEnvelope, CommandResult, IdempotencyReceipt } from "./types";
import type { NormalizeResult } from "../field-types/types";

type CommandBusDeps = {
  eventLedger: EventLedger;
  fieldTypeRegistry: FieldTypeRegistry;
  permissionEngine: PermissionEngine;
  workflowOperatorRegistry: WorkflowOperatorRegistry;
  idFactory?: (prefix: string) => string;
  now?: () => Promise<string> | string;
};

export type CommandBus = {
  execute(command: CommandEnvelope): Promise<CommandResult>;
  normalizeFieldValue(fieldType: string, input: unknown): NormalizeResult;
};

function createRejectedResult(
  diagnostics: string[],
  logicalTime: string,
  receipts: IdempotencyReceipt[] = []
): CommandResult {
  return {
    accepted: false,
    diagnostics,
    events: [],
    permission: {
      allowed: diagnostics.length === 0,
      reasons: []
    },
    replayProjection: toReplayProjection(logicalTime, receipts),
    sideEffects: [],
    status: "rejected"
  };
}

export function createCommandBus(deps: CommandBusDeps): CommandBus {
  return {
    normalizeFieldValue(fieldType, input) {
      return deps.fieldTypeRegistry.require(fieldType).normalize(input, {
        fieldType
      });
    },
    async execute(command) {
      const logicalTime = await Promise.resolve(
        deps.now ? deps.now() : deps.eventLedger.now()
      );
      const scopeKey = scopeKeyForCommand(command);
      const validationDiagnostics = validateCommand(command);

      if (validationDiagnostics.length > 0) {
        return {
          ...createRejectedResult(validationDiagnostics, logicalTime),
          permission: {
            allowed: false,
            reasons: []
          }
        };
      }

      const permissionDecision = deps.permissionEngine.evaluateCommand(command);
      if (!permissionDecision.allowed) {
        return {
          ...createRejectedResult(permissionDecision.reasons, logicalTime),
          permission: permissionDecision
        };
      }

      const payloadHash = hashCommand(command);
      const matchedReceipt = await deps.eventLedger.findReceipt(
        scopeKey,
        command.idempotencyKey
      );

      if (matchedReceipt) {
        if (matchedReceipt.payloadHash !== payloadHash) {
          return {
            ...createRejectedResult(["idempotency_key_conflict"], logicalTime, [
              matchedReceipt
            ]),
            permission: permissionDecision
          };
        }

        return {
          ...cloneCommandResult(matchedReceipt.result),
          diagnostics: ["idempotent_replay"],
          permission: permissionDecision,
          replayProjection: toReplayProjection(logicalTime, [matchedReceipt])
        };
      }

      const eventId = deps.idFactory ? deps.idFactory("evt") : crypto.randomUUID();
      const event = buildAcceptedEvent(command, eventId);
      const result: CommandResult = {
        accepted: true,
        diagnostics: [],
        events: [event],
        permission: permissionDecision,
        replayProjection: toReplayProjection(logicalTime, []),
        sideEffects: buildAcceptedSideEffects(eventId),
        status: "accepted"
      };

      const committed = await deps.eventLedger.commitAcceptedCommand({
        scopeKey,
        command,
        event: {
          ...event,
          payload: command.payload,
          metadata: {
            actor: command.actor,
            permissionScopeHash: command.permissionScopeHash ?? null,
            permissionsVersion: command.permissionsVersion ?? null,
            schemaEpoch: command.schemaEpoch ?? null,
            scope: command.scope
          },
          createdAt: logicalTime
        },
        receipt: {
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          result
        }
      });

      return {
        ...result,
        replayProjection: toReplayProjection(logicalTime, committed.receipts, [
          command.commandId
        ])
      };
    }
  };
}
