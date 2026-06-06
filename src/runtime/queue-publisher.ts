import type { CloudTableEnv, CloudTableQueueMessage } from "./env";
import type { OutboxRow } from "../core/persistence/types";

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
  entries: readonly OutboxRow[]
): Promise<Array<{ outboxId: string; queue: string }>> {
  const published: Array<{ outboxId: string; queue: string }> = [];

  for (const entry of entries) {
    const queue = resolveQueue(env, entry.queue_name);

    if (!queue) {
      throw new Error(`Unsupported queue binding: ${entry.queue_name}`);
    }

    await queue.send(parseQueuePayload(entry));
    published.push({
      outboxId: entry.outbox_id,
      queue: entry.queue_name
    });
  }

  return published;
}
