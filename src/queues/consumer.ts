import type { MessageBatch } from "@cloudflare/workers-types";

import type { CloudTableEnv, CloudTableQueueMessage } from "../runtime/env";

export async function handleQueueBatch(
  batch: MessageBatch<CloudTableQueueMessage>,
  _env: CloudTableEnv,
  _ctx: ExecutionContext
): Promise<void> {
  for (const message of batch.messages) {
    switch (message.body.kind) {
      case "event-fanout":
      case "workflow-dispatch":
      case "projection-maintenance":
      case "dead-letter-reprocessor":
        message.ack();
        break;
      default:
        message.retry();
        break;
    }
  }
}

