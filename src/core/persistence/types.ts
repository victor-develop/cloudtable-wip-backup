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

export type CloudTableRepository = {
  findReceipt(scopeKey: string, idempotencyKey: string): Promise<IdempotencyReceipt | null>;
  commitAcceptedCommand(commit: EventLedgerCommit): Promise<{
    event: EventLedgerRecord;
    receipts: IdempotencyReceipt[];
  }>;
  listPendingOutboxEntries(input: { availableBefore: string; limit: number }): Promise<OutboxRow[]>;
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
  recordOutboxPublishFailure(input: {
    attemptedAt: string;
    nextAttemptAt: string;
    outboxId: string;
  }): Promise<void>;
};
