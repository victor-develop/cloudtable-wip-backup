import type { IdempotencyReceipt } from "../commands/types";
import type { EventLedgerCommit, EventLedgerRecord } from "../events/types";

export type ReceiptRow = {
  receipt_json: string;
};

export type OutboxRow = {
  outbox_id: string;
  workspace_id: string;
  event_id: string;
  queue_name: string;
  payload_json: string;
  available_at: string;
  delivered_at: string | null;
  delivery_attempts: number;
  created_at: string;
};

export type ActivityHistoryEntry = {
  actorMode: string | null;
  actorPrincipalId: string | null;
  aggregateId: string | null;
  aggregateType: string | null;
  commandId: string;
  commandType: string | null;
  createdAt: string;
  eventId: string;
  eventType: string;
  recordId: string | null;
  recordKey: string | null;
  tableId: string | null;
  tableSequence: number | null;
  workspaceSequence: number;
};

export type ProvisionWorkspaceMembershipIdentityInput = {
  externalIdentity?: {
    email?: string | null;
    externalSubject: string;
    id: string;
    providerKey: string;
  } | null;
  membership: {
    organizationMembershipId: string;
    principalId: string;
    roleKey: string;
    status?: string;
    workspaceMembershipId: string;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  timestamp: string;
  user: {
    displayName?: string | null;
    email?: string | null;
    id: string;
  };
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
};

export type WorkspaceMembershipIdentityRecord = {
  organizationId: string;
  organizationMembershipId: string;
  organizationMembershipStatus: string;
  organizationName: string;
  organizationRoleKey: string;
  organizationSlug: string;
  principalId: string;
  userDisplayName: string | null;
  userEmail: string | null;
  userId: string;
  workspaceId: string;
  workspaceMembershipId: string;
  workspaceMembershipStatus: string;
  workspacePrincipalId: string | null;
  workspacePrincipalRoleKey: string | null;
  workspaceRoleKey: string;
};

export type CanonicalUserRecord = {
  displayName: string | null;
  primaryEmail: string | null;
  userId: string;
};

export type AuthSessionRecord = {
  activeWorkspaceId: string | null;
  createdAt: string;
  expiresAt: string;
  lastAuthenticatedAt: string;
  sessionId: string;
  userDisplayName: string | null;
  userEmail: string | null;
  userId: string;
};

export type InvitationRecord = {
  acceptedAt: string | null;
  createdAt: string;
  expiresAt: string;
  id: string;
  invitedByUserId: string | null;
  invitedEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  roleKey: string;
  status: string;
  tokenHash: string;
  updatedAt: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
};

export type CloudTableRepository = {
  acceptInvitation(input: {
    acceptedByUserId: string;
    acceptedDisplayName?: string | null;
    acceptedEmail: string;
    acceptedExternalIdentity?: {
      email?: string | null;
      externalSubject: string;
      id: string;
      providerKey: string;
    } | null;
    acceptedPrincipalId: string;
    acceptedUserId: string;
    invitationId: string;
    organizationMembershipId: string;
    timestamp: string;
    workspaceMembershipId: string;
  }): Promise<WorkspaceMembershipIdentityRecord | null>;
  createAuthSession(input: {
    activeWorkspaceId?: string | null;
    expiresAt: string;
    lastAuthenticatedAt: string;
    sessionId: string;
    userId: string;
  }): Promise<AuthSessionRecord>;
  createInvitation(input: {
    expiresAt: string;
    id: string;
    invitedByUserId?: string | null;
    invitedEmail: string;
    roleKey: string;
    timestamp: string;
    tokenHash: string;
    workspaceId: string;
  }): Promise<InvitationRecord | null>;
  findReceipt(scopeKey: string, idempotencyKey: string): Promise<IdempotencyReceipt | null>;
  findInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  findUserByEmail(email: string): Promise<CanonicalUserRecord | null>;
  findUserByExternalIdentity(input: {
    externalSubject: string;
    providerKey: string;
  }): Promise<CanonicalUserRecord | null>;
  commitAcceptedCommand(commit: EventLedgerCommit): Promise<{
    event: EventLedgerRecord;
    receipts: IdempotencyReceipt[];
  }>;
  linkExternalIdentityToUser(input: {
    email?: string | null;
    externalIdentityId: string;
    externalSubject: string;
    providerKey: string;
    timestamp: string;
    userId: string;
  }): Promise<"linked" | "noop" | "conflict">;
  listPendingOutboxEntries(input: { availableBefore: string; limit: number }): Promise<OutboxRow[]>;
  listWorkspaceMembershipIdentitiesForUser(userId: string): Promise<WorkspaceMembershipIdentityRecord[]>;
  listAppActivity(input: {
    appId: string;
    beforeWorkspaceSequence?: number | null;
    limit: number;
    workspaceId: string;
  }): Promise<ActivityHistoryEntry[]>;
  listRecordActivity(input: {
    beforeTableSequence?: number | null;
    limit: number;
    recordId: string;
    tableId: string;
    workspaceId: string;
  }): Promise<ActivityHistoryEntry[]>;
  listTableActivity(input: {
    beforeTableSequence?: number | null;
    limit: number;
    tableId: string;
    workspaceId: string;
  }): Promise<ActivityHistoryEntry[]>;
  listWorkspaceActivity(input: {
    beforeWorkspaceSequence?: number | null;
    limit: number;
    workspaceId: string;
  }): Promise<ActivityHistoryEntry[]>;
  listOutboxEntriesForEvent(eventId: string): Promise<OutboxRow[]>;
  markOutboxEntryDelivered(input: { deliveredAt: string; outboxId: string }): Promise<void>;
  provisionWorkspaceMembershipIdentity(
    input: ProvisionWorkspaceMembershipIdentityInput
  ): Promise<WorkspaceMembershipIdentityRecord>;
  readAuthSession(sessionId: string): Promise<AuthSessionRecord | null>;
  readWorkspaceMembershipIdentity(
    input: { principalId: string; workspaceId: string }
  ): Promise<WorkspaceMembershipIdentityRecord | null>;
  readWorkspaceMembershipIdentityForUser(input: {
    userId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembershipIdentityRecord | null>;
  recordOutboxPublishFailure(input: {
    attemptedAt: string;
    nextAttemptAt: string;
    outboxId: string;
  }): Promise<void>;
  updateAuthSessionActiveWorkspace(input: {
    activeWorkspaceId: string | null;
    sessionId: string;
  }): Promise<AuthSessionRecord | null>;
  userHasActiveWorkspaceMembership(input: { principalId: string; workspaceId: string }): Promise<boolean>;
  workspaceHasMembershipFoundation(workspaceId: string): Promise<boolean>;
};
