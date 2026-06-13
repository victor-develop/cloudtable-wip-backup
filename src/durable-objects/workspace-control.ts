import type { CommandEnvelope } from "../core/commands/types";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import type { ProvisionWorkspaceMembershipIdentityInput } from "../core/persistence/types";
import { createRuntime } from "../runtime/bootstrap";
import type { CloudTableEnv } from "../runtime/env";
import { badRequest, json, notFound } from "../runtime/http";
import { publishOutboxEntries } from "../runtime/queue-publisher";
import { readWorkflowExecutionCandidate } from "../runtime/workflow-definition";

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
      if (command.commandType === "workflow.manual") {
        const workflowId =
          typeof command.payload.workflowId === "string" ? command.payload.workflowId : null;
        if (!workflowId) {
          return badRequest("workflowId is required for manual workflow execution.");
        }

        const candidate = await readWorkflowExecutionCandidate(
          this.env.DB,
          command.workspaceId,
          workflowId
        );
        if (!candidate.ok) {
          return json(
            {
              coordinator: {
                durableObject: "workspace-control",
                objectId: this.state.id.toString()
              },
              result: {
                accepted: false,
                diagnostics: [candidate.reason],
                events: [],
                permission: {
                  allowed: false,
                  reasons: [candidate.reason]
                },
                replayProjection: {
                  acceptedCommandIds: [],
                  lastLogicalTime: new Date(0).toISOString(),
                  receiptCount: 0,
                  receipts: []
                },
                sideEffects: [],
                status: "rejected"
              }
            },
            { status: 200 }
          );
        }
      }

      const runtime = createRuntime(this.env);
      const result = await runtime.commandBus.execute({
        ...command,
        scope: command.scope === "workflow" ? "workflow" : "workspace"
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

      return json({
        coordinator: {
          durableObject: "workspace-control",
          objectId: this.state.id.toString(),
          published
        },
        result
      });
    }

    if (request.method === "POST" && url.pathname === "/memberships") {
      const body = (await request.json()) as Partial<ProvisionWorkspaceMembershipIdentityInput>;
      const workspaceId =
        typeof body.workspace?.id === "string" && body.workspace.id.length > 0
          ? body.workspace.id
          : null;
      const organizationId =
        typeof body.organization?.id === "string" && body.organization.id.length > 0
          ? body.organization.id
          : null;
      const organizationSlug =
        typeof body.organization?.slug === "string" && body.organization.slug.length > 0
          ? body.organization.slug
          : null;
      const organizationName =
        typeof body.organization?.name === "string" && body.organization.name.length > 0
          ? body.organization.name
          : null;
      const workspaceSlug =
        typeof body.workspace?.slug === "string" && body.workspace.slug.length > 0
          ? body.workspace.slug
          : null;
      const workspaceName =
        typeof body.workspace?.name === "string" && body.workspace.name.length > 0
          ? body.workspace.name
          : null;
      const userId = typeof body.user?.id === "string" && body.user.id.length > 0 ? body.user.id : null;
      const organizationMembershipId =
        typeof body.membership?.organizationMembershipId === "string" &&
        body.membership.organizationMembershipId.length > 0
          ? body.membership.organizationMembershipId
          : null;
      const workspaceMembershipId =
        typeof body.membership?.workspaceMembershipId === "string" &&
        body.membership.workspaceMembershipId.length > 0
          ? body.membership.workspaceMembershipId
          : null;
      const principalId =
        typeof body.membership?.principalId === "string" && body.membership.principalId.length > 0
          ? body.membership.principalId
          : null;
      const roleKey =
        typeof body.membership?.roleKey === "string" && body.membership.roleKey.length > 0
          ? body.membership.roleKey
          : null;

      if (
        !workspaceId ||
        !organizationId ||
        !organizationSlug ||
        !organizationName ||
        !workspaceSlug ||
        !workspaceName ||
        !userId ||
        !organizationMembershipId ||
        !workspaceMembershipId ||
        !principalId ||
        !roleKey
      ) {
        return badRequest(
          "workspace, organization, user, and membership identity metadata are required for membership provisioning."
        );
      }

      const repository = createCloudTableD1Repository(this.env.DB, createRuntime(this.env).fieldTypeRegistry);
      const membership = await repository.provisionWorkspaceMembershipIdentity({
        externalIdentity: body.externalIdentity ?? null,
        membership: {
          organizationMembershipId,
          principalId,
          roleKey,
          status: body.membership?.status,
          workspaceMembershipId
        },
        organization: {
          id: organizationId,
          name: organizationName,
          slug: organizationSlug
        },
        timestamp:
          typeof body.timestamp === "string" && body.timestamp.length > 0
            ? body.timestamp
            : new Date().toISOString(),
        user: {
          displayName: body.user?.displayName ?? null,
          email: body.user?.email ?? null,
          id: userId
        },
        workspace: {
          id: workspaceId,
          name: workspaceName,
          slug: workspaceSlug
        }
      });

      return json({
        coordinator: {
          durableObject: "workspace-control",
          objectId: this.state.id.toString()
        },
        membership
      });
    }

    const membershipDetailMatch = url.pathname.match(/^\/memberships\/([^/]+)$/);
    if (request.method === "GET" && membershipDetailMatch) {
      const principalId = decodeURIComponent(membershipDetailMatch[1]!);
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) {
        return badRequest("workspaceId is required for membership lookup.");
      }

      const repository = createCloudTableD1Repository(this.env.DB, createRuntime(this.env).fieldTypeRegistry);
      const membership = await repository.readWorkspaceMembershipIdentity({
        principalId,
        workspaceId
      });
      if (!membership) {
        return notFound(
          `Workspace membership ${principalId} was not found in workspace ${workspaceId}.`
        );
      }

      return json({
        coordinator: {
          durableObject: "workspace-control",
          objectId: this.state.id.toString()
        },
        membership
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
