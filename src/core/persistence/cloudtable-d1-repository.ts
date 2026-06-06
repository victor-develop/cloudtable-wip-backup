import { toCanonicalJson } from "../commands/transcript";
import type { IdempotencyReceipt } from "../commands/types";
import type { EventLedgerCommit, EventLedgerRecord } from "../events/types";
import type { CloudTableRepository, OutboxRow, ReceiptRow } from "./types";

type SequenceRow = {
  nextSequence: number;
};

function parseReceipt(row: ReceiptRow): IdempotencyReceipt {
  return JSON.parse(row.receipt_json) as IdempotencyReceipt;
}

function projectionPayloadFromCommit(commit: EventLedgerCommit): {
  projection_json: string;
  record_id: string;
} | null {
  const recordId = commit.command.payload.recordId;
  if (typeof recordId !== "string" || recordId.length === 0 || !commit.command.tableId) {
    return null;
  }

  return {
    projection_json: toCanonicalJson({
      commandId: commit.command.commandId,
      commandType: commit.command.commandType,
      eventId: commit.event.eventId,
      recordId
    }).trimEnd(),
    record_id: recordId
  };
}

async function nextWorkspaceSequence(
  db: D1Database,
  workspaceId: string
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COALESCE(MAX(workspace_sequence), 0) + 1 AS nextSequence
       FROM event_ledger
       WHERE workspace_id = ?`
    )
    .bind(workspaceId)
    .first<SequenceRow>();

  return result?.nextSequence ?? 1;
}

async function nextTableSequence(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COALESCE(MAX(table_sequence), 0) + 1 AS nextSequence
       FROM event_ledger
       WHERE workspace_id = ? AND table_id = ?`
    )
    .bind(workspaceId, tableId)
    .first<SequenceRow>();

  return result?.nextSequence ?? 1;
}

export function createCloudTableD1Repository(db: D1Database): CloudTableRepository {
  return {
    async findReceipt(scopeKey, idempotencyKey) {
      const row = await db
        .prepare(
          `SELECT receipt_json
           FROM idempotency_receipts
           WHERE scope_key = ? AND idempotency_key = ?`
        )
        .bind(scopeKey, idempotencyKey)
        .first<ReceiptRow>();

      return row ? parseReceipt(row) : null;
    },

    async listOutboxEntriesForEvent(eventId) {
      const rows = await db
        .prepare(
          `SELECT
             outbox_id,
             workspace_id,
             event_id,
             queue_name,
             payload_json,
             available_at,
             delivered_at,
             delivery_attempts,
             created_at
           FROM queue_outbox
           WHERE event_id = ?
           ORDER BY created_at ASC, outbox_id ASC`
        )
        .bind(eventId)
        .all<OutboxRow>();

      return rows.results ?? [];
    },

    async commitAcceptedCommand(commit) {
      const workspaceSequence = await nextWorkspaceSequence(db, commit.command.workspaceId);
      const tableSequence = commit.command.tableId
        ? await nextTableSequence(db, commit.command.workspaceId, commit.command.tableId)
        : null;
      const projection = projectionPayloadFromCommit(commit);

      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `INSERT INTO event_ledger (
              event_id,
              workspace_id,
              table_id,
              event_type,
              command_id,
              aggregate_id,
              workspace_sequence,
              table_sequence,
              payload_json,
              metadata_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            commit.event.eventId,
            commit.event.workspaceId,
            commit.event.tableId,
            commit.event.eventType,
            commit.event.commandId,
            null,
            workspaceSequence,
            tableSequence,
            JSON.stringify(commit.event.payload),
            JSON.stringify({
              ...commit.event.metadata,
              commandType: commit.event.commandType
            }),
            commit.event.createdAt
          ),
        db
          .prepare(
            `INSERT INTO idempotency_receipts (
              id,
              scope_key,
              idempotency_key,
              command_id,
              receipt_json,
              created_at,
              last_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `receipt:${commit.event.eventId}`,
            commit.scopeKey,
            commit.receipt.idempotencyKey,
            commit.command.commandId,
            JSON.stringify(commit.receipt),
            commit.event.createdAt,
            commit.event.eventId
          ),
        db
          .prepare(
            `INSERT INTO queue_outbox (
              outbox_id,
              workspace_id,
              event_id,
              queue_name,
              payload_json,
              available_at,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `outbox:${commit.event.eventId}:event-fanout`,
            commit.command.workspaceId,
            commit.event.eventId,
            "event-fanout",
            JSON.stringify({
              commandId: commit.command.commandId,
              eventId: commit.event.eventId,
              eventType: commit.event.eventType,
              workspaceId: commit.command.workspaceId
            }),
            commit.event.createdAt,
            commit.event.createdAt
          )
      ];

      if (projection) {
        statements.push(
          db
            .prepare(
              `INSERT INTO record_projection (
                workspace_id,
                table_id,
                record_id,
                projection_json,
                search_document,
                projection_version,
                last_event_id,
                updated_at
              ) VALUES (?, ?, ?, ?, '', 1, ?, ?)
              ON CONFLICT(workspace_id, table_id, record_id) DO UPDATE SET
                projection_json = excluded.projection_json,
                projection_version = record_projection.projection_version + 1,
                last_event_id = excluded.last_event_id,
                updated_at = excluded.updated_at`
            )
            .bind(
              commit.command.workspaceId,
              commit.command.tableId,
              projection.record_id,
              projection.projection_json,
              commit.event.eventId,
              commit.event.createdAt
            )
        );
      }

      await db.batch(statements);

      const receiptRows = await db
        .prepare(
          `SELECT receipt_json
           FROM idempotency_receipts
           WHERE scope_key = ?
           ORDER BY created_at ASC, id ASC`
        )
        .bind(commit.scopeKey)
        .all<ReceiptRow>();

      return {
        event: {
          ...commit.event,
          metadata: {
            ...commit.event.metadata,
            tableSequence,
            workspaceSequence
          }
        } satisfies EventLedgerRecord,
        receipts: (receiptRows.results ?? []).map(parseReceipt)
      };
    }
  };
}
