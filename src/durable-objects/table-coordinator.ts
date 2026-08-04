import type { CommandEnvelope, CommandResult } from "../core/commands/types";
import {
  buildAcceptedEvent,
  buildAcceptedSideEffects,
  hashCommand,
  scopeKeyForCommand,
  toReplayProjection
} from "../core/commands/transcript";
import { createEventLedger } from "../core/events/event-ledger";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import { createRuntime, createRuntimeWithSnapshot } from "../runtime/bootstrap";
import type { CloudTableEnv } from "../runtime/env";
import { badRequest, json } from "../runtime/http";
import { readLatestPermissionSnapshotForScope } from "../runtime/permission-snapshot";
import { publishOutboxEntries } from "../runtime/queue-publisher";

type DurableObjectContextLike = DurableObjectState;

type WorkspaceLease = {
  leaseId: string;
  startSequence: number;
  endSequence: number;
  size: number;
  ownerKey: string;
};

type CoordinatorState = {
  lease: WorkspaceLease | null;
};

export class TableCoordinatorDurableObject {
  constructor(
    private readonly state: DurableObjectContextLike,
    private readonly env: CloudTableEnv
  ) {}

  private async getState(): Promise<CoordinatorState> {
    return (await this.state.storage.get<CoordinatorState>("coordinator-state")) ?? {
      lease: null
    };
  }

  private async setState(next: CoordinatorState): Promise<void> {
    await this.state.storage.put("coordinator-state", next);
  }

  private async ensureLease(command: CommandEnvelope): Promise<WorkspaceLease> {
    const state = await this.getState();
    if (state.lease) {
      return state.lease;
    }

    const workspaceId = command.workspaceId;
    const id = this.env.WORKSPACE_CONTROL_DO.idFromName(workspaceId);
    const stub = this.env.WORKSPACE_CONTROL_DO.get(id);
    const response = await stub.fetch(
      new Request("https://cloudtable.internal/leases", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId,
          ownerKey: `${workspaceId}:${command.tableId ?? "unknown-table"}`,
          size: 256
        })
      })
    );

    if (!response.ok) {
      throw new Error(`Failed to allocate workspace sequence lease: ${response.status}`);
    }

    const payload = (await response.json()) as { lease: WorkspaceLease };
    const next = {
      lease: payload.lease
    };
    await this.setState(next);
    return payload.lease;
  }

  private async executeCommand(command: CommandEnvelope): Promise<{
    lease: WorkspaceLease;
    published: Array<{ outboxId: string; queue: string }>;
    result: CommandResult;
  }> {
    if (!command.tableId) {
      throw new Error("tableId is required for table-scoped commands.");
    }

    const lease = await this.ensureLease(command);
    const runtime = createRuntime(this.env);
    const result = await runtime.commandBus.execute({
      ...command,
      scope: "table"
    });
    const repository = createCloudTableD1Repository(this.env.DB, runtime.fieldTypeRegistry);

    const eventId = result.events[0]?.eventId;
    const published =
      result.accepted &&
      eventId &&
      !result.diagnostics.includes("idempotent_replay")
        ? (
            await publishOutboxEntries(
            this.env,
            repository,
            await repository.listOutboxEntriesForEvent(eventId)
          )
          ).published
        : [];

    return {
      lease,
      published,
      result
    };
  }

  private async executeCoordinatorOwnedCellSet(command: CommandEnvelope): Promise<{
    replayed: boolean;
    result: CommandResult;
  }> {
    if (!command.tableId) {
      throw new Error("tableId is required for table-scoped commands.");
    }

    const eventLedger = createEventLedger(this.env.DB);
    const scopeKey = scopeKeyForCommand(command);
    const payloadHash = hashCommand(command);
    const logicalTime = await eventLedger.now();
    const matchedReceipt = await eventLedger.findReceipt(scopeKey, command.idempotencyKey);

    if (matchedReceipt) {
      if (matchedReceipt.payloadHash !== payloadHash) {
        throw new Error(`Idempotency key conflict for ${command.idempotencyKey}.`);
      }

      return {
        replayed: true,
        result: {
          ...structuredClone(matchedReceipt.result),
          diagnostics: ["idempotent_replay"],
          replayProjection: toReplayProjection(logicalTime, [matchedReceipt]),
          status: matchedReceipt.result.status
        }
      };
    }

    const eventId = crypto.randomUUID();
    const snapshot = await readLatestPermissionSnapshotForScope(this.env.DB, {
      permissionScopeHash: command.permissionScopeHash ?? null,
      principalId: command.actor.principalId,
      workspaceId: command.workspaceId
    });
    const permissionDecision = createRuntimeWithSnapshot(
      this.env,
      snapshot
    ).permissionEngine.evaluateCommand(command);
    if (!permissionDecision.allowed) {
      throw new Error(
        `Coordinator-owned cell set denied: ${permissionDecision.reasons.join(", ")}`
      );
    }

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

    await eventLedger.commitAcceptedCommand({
      command,
      event: {
        ...event,
        createdAt: logicalTime,
        metadata: {
          actor: command.actor,
          coordinatorOwnedMutation: true,
          permissionScopeHash: command.permissionScopeHash ?? null,
          permissionsVersion: command.permissionsVersion ?? null,
          schemaEpoch: command.schemaEpoch ?? null,
          scope: command.scope
        },
        payload: command.payload
      },
      receipt: {
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        result
      },
      scopeKey
    });

    const repository = createCloudTableD1Repository(this.env.DB, createRuntime(this.env).fieldTypeRegistry);
    const published = await publishOutboxEntries(
      this.env,
      repository,
      await repository.listOutboxEntriesForEvent(eventId)
    );

    return {
      replayed: false,
      result: {
        ...result,
        replayProjection: toReplayProjection(logicalTime, [
          {
            idempotencyKey: command.idempotencyKey,
            payloadHash,
            result
          }
        ], [command.commandId])
      }
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        durableObject: "table-coordinator"
      });
    }

    if (request.method === "POST" && url.pathname === "/commands") {
      const command = (await request.json()) as CommandEnvelope;
      if (!command.workspaceId) {
        return badRequest("workspaceId is required.");
      }
      if (!command.tableId) {
        return badRequest("tableId is required.");
      }

      const { lease, published, result } = await this.executeCommand(command);

      return json({
        coordinator: {
          durableObject: "table-coordinator",
          lease,
          objectId: this.state.id.toString(),
          published
        },
        result
      });
    }

    if (request.method === "POST" && url.pathname === "/internal/aggregate-maintenance") {
      const body = (await request.json()) as {
        command?: CommandEnvelope;
      };
      if (!body.command) {
        return badRequest("command is required.");
      }

      const outcome = await this.executeCoordinatorOwnedCellSet(body.command);
      return json({
        coordinator: {
          durableObject: "table-coordinator",
          objectId: this.state.id.toString()
        },
        replayed: outcome.replayed,
        result: outcome.result
      });
    }

    return Response.json(
      {
        error: "not_implemented",
        message:
          "Table-scoped record mutations, row ordering, and idempotent event commits belong here."
      },
      { status: 501 }
    );
  }
}
