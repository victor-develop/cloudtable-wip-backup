import type { EventLedger } from "../events/types";
import type { FieldTypeRegistry, NormalizeResult } from "../field-types/types";
import type { PermissionEngine } from "../permissions/types";
import type { WorkflowOperatorRegistry } from "../workflows/types";
import { validateDomainCommand } from "./domain";
import { isCommandCommitError } from "./errors";
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

type CommandBusDeps = {
  eventLedger: EventLedger;
  fieldTypeRegistry: FieldTypeRegistry;
  permissionEngine: PermissionEngine;
  workflowOperatorRegistry: WorkflowOperatorRegistry;
  idFactory?: (prefix: string) => string;
  now?: () => Promise<string> | string;
};

export type CommandBus = {
  dryRun(command: CommandEnvelope): Promise<CommandResult>;
  execute(command: CommandEnvelope): Promise<CommandResult>;
  normalizeFieldValue(fieldType: string, input: unknown): NormalizeResult;
};

type PreparedCommand =
  | {
      rejected: CommandResult;
    }
  | {
      logicalTime: string;
      matchedReceipt: IdempotencyReceipt | null;
      payloadHash: string;
      permissionDecision: CommandResult["permission"];
      scopeKey: string;
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
    async dryRun(command) {
      const prepared = await prepareCommand(deps, command);
      if ("rejected" in prepared) {
        return prepared.rejected;
      }

      if (prepared.matchedReceipt) {
        return {
          ...cloneCommandResult(prepared.matchedReceipt.result),
          diagnostics: ["idempotent_replay"],
          permission: prepared.permissionDecision,
          replayProjection: toReplayProjection(prepared.logicalTime, [
            prepared.matchedReceipt
          ])
        };
      }

      return {
        accepted: true,
        diagnostics: ["dry_run"],
        events: [],
        permission: prepared.permissionDecision,
        replayProjection: toReplayProjection(prepared.logicalTime, []),
        sideEffects: [],
        status: "accepted"
      };
    },
    async execute(command) {
      const prepared = await prepareCommand(deps, command);
      if ("rejected" in prepared) {
        return prepared.rejected;
      }

      const {
        logicalTime,
        matchedReceipt,
        payloadHash,
        permissionDecision,
        scopeKey
      } = prepared;

      if (matchedReceipt) {
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
        sideEffects: buildAcceptedSideEffects(command, eventId),
        status: "accepted"
      };

      let committed;
      try {
        committed = await deps.eventLedger.commitAcceptedCommand({
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
      } catch (error) {
        if (isCommandCommitError(error)) {
          return {
            ...createRejectedResult([error.diagnostic], logicalTime),
            permission: permissionDecision
          };
        }

        throw error;
      }

      return {
        ...result,
        replayProjection: toReplayProjection(logicalTime, committed.receipts, [
          command.commandId
        ])
      };
    }
  };
}

async function prepareCommand(
  deps: CommandBusDeps,
  command: CommandEnvelope
): Promise<PreparedCommand> {
  const logicalTime = await Promise.resolve(
    deps.now ? deps.now() : deps.eventLedger.now()
  );
  const scopeKey = scopeKeyForCommand(command);
  const validationDiagnostics = [
      ...validateCommand(command),
      ...validateDomainCommand(
        command,
        deps.fieldTypeRegistry,
        deps.workflowOperatorRegistry
      )
    ];

  if (validationDiagnostics.length > 0) {
    return {
      rejected: {
        ...createRejectedResult(validationDiagnostics, logicalTime),
        permission: {
          allowed: false,
          reasons: []
        }
      }
    };
  }

  const permissionDecision = deps.permissionEngine.evaluateCommand(command);
  if (!permissionDecision.allowed) {
    return {
      rejected: {
        ...createRejectedResult(permissionDecision.reasons, logicalTime),
        permission: permissionDecision
      }
    };
  }

  const payloadHash = hashCommand(command);
  const matchedReceipt = await deps.eventLedger.findReceipt(
    scopeKey,
    command.idempotencyKey
  );

  if (matchedReceipt && matchedReceipt.payloadHash !== payloadHash) {
    return {
      rejected: {
        ...createRejectedResult(["idempotency_key_conflict"], logicalTime, [
          matchedReceipt
        ]),
        permission: permissionDecision
      }
    };
  }

  return {
    logicalTime,
    matchedReceipt,
    payloadHash,
    permissionDecision,
    scopeKey
  };
}
