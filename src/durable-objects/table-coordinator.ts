import type { CommandEnvelope, CommandResult } from "../core/commands/types";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import { createRuntime } from "../runtime/bootstrap";
import type { CloudTableEnv } from "../runtime/env";
import { badRequest, json } from "../runtime/http";
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
    const repository = createCloudTableD1Repository(this.env.DB);

    const eventId = result.events[0]?.eventId;
    const published =
      result.accepted && eventId
        ? await publishOutboxEntries(
            this.env,
            await repository.listOutboxEntriesForEvent(eventId)
          )
        : [];

    return {
      lease,
      published,
      result
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
