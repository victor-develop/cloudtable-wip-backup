import type { CloudTableEnv, CloudTableQueueMessage } from "./env";
import type { CloudTableRepository, OutboxRow } from "../core/persistence/types";

const OUTBOX_RETRY_BASE_DELAY_MS = 60_000;
const OUTBOX_RETRY_MAX_DELAY_MS = 30 * 60_000;
export const OUTBOX_DRAIN_BATCH_LIMIT = 100;

function parseQueuePayload(row: OutboxRow): CloudTableQueueMessage {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

  return {
    kind: row.queue_name as CloudTableQueueMessage["kind"],
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    payload
  };
}

function resolveQueue(
  env: CloudTableEnv,
  queueName: OutboxRow["queue_name"]
): Queue<CloudTableQueueMessage> | null {
  switch (queueName) {
    case "event-fanout":
      return env.EVENT_FANOUT_QUEUE;
    case "workflow-dispatch":
      return env.WORKFLOW_DISPATCH_QUEUE;
    case "projection-maintenance":
      return env.PROJECTION_MAINTENANCE_QUEUE;
    case "dead-letter-reprocessor":
      return env.DEAD_LETTER_REPROCESSOR_QUEUE;
    default:
      return null;
  }
}

export async function publishOutboxEntries(
  env: CloudTableEnv,
  repository: CloudTableRepository,
  entries: readonly OutboxRow[]
): Promise<{
  failed: Array<{ outboxId: string; queue: string }>;
  published: Array<{ outboxId: string; queue: string }>;
}> {
  const published: Array<{ outboxId: string; queue: string }> = [];
  const failed: Array<{ outboxId: string; queue: string }> = [];

  for (const entry of entries) {
    const queue = resolveQueue(env, entry.queue_name);

    if (!queue) {
      throw new Error(`Unsupported queue binding: ${entry.queue_name}`);
    }

    const attemptedAt = new Date().toISOString();

    try {
      await queue.send(parseQueuePayload(entry));
      await repository.markOutboxEntryDelivered({
        deliveredAt: attemptedAt,
        outboxId: entry.outbox_id
      });
      published.push({
        outboxId: entry.outbox_id,
        queue: entry.queue_name
      });
    } catch {
      await repository.recordOutboxPublishFailure({
        attemptedAt,
        nextAttemptAt: nextOutboxAttemptAt(entry, attemptedAt),
        outboxId: entry.outbox_id
      });
      failed.push({
        outboxId: entry.outbox_id,
        queue: entry.queue_name
      });
    }
  }

  return {
    failed,
    published
  };
}

export async function drainPendingOutboxEntries(
  env: CloudTableEnv,
  repository: CloudTableRepository,
  availableBefore: string,
  limit = OUTBOX_DRAIN_BATCH_LIMIT
): Promise<{
  failed: Array<{ outboxId: string; queue: string }>;
  published: Array<{ outboxId: string; queue: string }>;
}> {
  const entries = await repository.listPendingOutboxEntries({
    availableBefore,
    limit
  });

  return publishOutboxEntries(env, repository, entries);
}

function nextOutboxAttemptAt(entry: OutboxRow, attemptedAt: string): string {
  const attempt = entry.delivery_attempts + 1;
  const delayMs = Math.min(
    OUTBOX_RETRY_MAX_DELAY_MS,
    OUTBOX_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );

  return new Date(Date.parse(attemptedAt) + delayMs).toISOString();
}
