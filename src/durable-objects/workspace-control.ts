import type { CommandEnvelope } from "../core/commands/types";
import { createRuntime } from "../runtime/bootstrap";
import type { CloudTableEnv } from "../runtime/env";
import { badRequest, json } from "../runtime/http";

type DurableObjectContextLike = DurableObjectState;

type LeaseRequest = {
  workspaceId: string;
  ownerKey: string;
  size?: number;
};

type LeaseRow = {
  lease_id: string;
  start_sequence: number;
  end_sequence: number;
  next_sequence: number;
};

export class WorkspaceControlDurableObject {
  constructor(
    private readonly state: DurableObjectContextLike,
    private readonly env: CloudTableEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        durableObject: "workspace-control"
      });
    }

    if (request.method === "POST" && url.pathname === "/commands") {
      const command = (await request.json()) as CommandEnvelope;
      const runtime = createRuntime(this.env);
      const result = await runtime.commandBus.execute({
        ...command,
        scope: "workspace"
      });

      return json({
        coordinator: {
          durableObject: "workspace-control",
          objectId: this.state.id.toString()
        },
        result
      });
    }

    if (request.method === "POST" && url.pathname === "/leases") {
      const body = (await request.json()) as LeaseRequest;
      if (!body.workspaceId) {
        return badRequest("workspaceId is required.");
      }
      if (!body.ownerKey) {
        return badRequest("ownerKey is required.");
      }

      const size = Math.max(1, Math.min(body.size ?? 256, 1024));
      const workspaceId = body.workspaceId;
      const now = new Date().toISOString();
      const latestLease = await this.env.DB.prepare(
        `SELECT lease_id, start_sequence, end_sequence, next_sequence
         FROM workspace_sequence_leases
         WHERE workspace_id = ?
         ORDER BY end_sequence DESC
         LIMIT 1`
      )
        .bind(workspaceId)
        .first<LeaseRow>();
      const startSequence = latestLease ? latestLease.end_sequence + 1 : 1;
      const endSequence = startSequence + size - 1;
      const leaseId = `lease:${workspaceId}:${body.ownerKey}:${startSequence}`;

      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO workspace_sequence_leases (
             lease_id,
             workspace_id,
             lease_owner_key,
             start_sequence,
             end_sequence,
             next_sequence,
             status,
             leased_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          leaseId,
          workspaceId,
          body.ownerKey,
          startSequence,
          endSequence,
          startSequence,
          "active",
          now
        )
      ]);

      return json({
        coordinator: {
          durableObject: "workspace-control",
          objectId: this.state.id.toString()
        },
        lease: {
          endSequence,
          leaseId,
          ownerKey: body.ownerKey,
          size,
          startSequence
        }
      });
    }

    return Response.json(
      {
        error: "not_implemented",
        message:
          "Workspace-scoped schema, policy, workflow, and lease commands belong here."
      },
      { status: 501 }
    );
  }
}
