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

export type CloudTableRepository = {
  findReceipt(scopeKey: string, idempotencyKey: string): Promise<IdempotencyReceipt | null>;
  commitAcceptedCommand(commit: EventLedgerCommit): Promise<{
    event: EventLedgerRecord;
    receipts: IdempotencyReceipt[];
  }>;
  listOutboxEntriesForEvent(eventId: string): Promise<OutboxRow[]>;
};
