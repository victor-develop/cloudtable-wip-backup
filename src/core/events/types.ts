import type { CommandEnvelope, IdempotencyReceipt } from "../commands/types";

export type EventLedgerRecord = {
  eventId: string;
  workspaceId: string;
  tableId: string | null;
  commandId: string;
  commandType: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type EventLedgerCommit = {
  scopeKey: string;
  command: CommandEnvelope;
  event: EventLedgerRecord;
  receipt: IdempotencyReceipt;
};

export type EventLedger = {
  now(): Promise<string>;
  findReceipt(scopeKey: string, idempotencyKey: string): Promise<IdempotencyReceipt | null>;
  commitAcceptedCommand(commit: EventLedgerCommit): Promise<{
    event: EventLedgerRecord;
    receipts: IdempotencyReceipt[];
  }>;
};
