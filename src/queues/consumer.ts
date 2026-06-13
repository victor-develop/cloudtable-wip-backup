import type { MessageBatch } from "@cloudflare/workers-types";

import type { CloudTableEnv, CloudTableQueueMessage } from "../runtime/env";
import { processAggregateMaintenanceMessage } from "../runtime/aggregate-maintenance";
import { processProjectionMaintenanceMessage } from "../runtime/projection-maintenance";
import {
  processDeadLetterReprocessorMessage,
  processEventFanoutMessage,
  processWorkflowDispatchMessage,
  processWorkflowStepMessage
} from "../runtime/workflow-runtime";

export async function handleQueueBatch(
  batch: MessageBatch<CloudTableQueueMessage>,
  _env: CloudTableEnv,
  _ctx: ExecutionContext
): Promise<void> {
  for (const message of batch.messages) {
    try {
      switch (message.body.kind) {
        case "event-fanout":
          await processEventFanoutMessage(_env, message.body);
          message.ack();
          break;
        case "workflow-dispatch":
          await processWorkflowDispatchMessage(_env, message.body);
          message.ack();
          break;
        case "workflow-step":
          await processWorkflowStepMessage(_env, message.body);
          message.ack();
          break;
        case "projection-maintenance":
          await processProjectionMaintenanceMessage(_env, message.body);
          message.ack();
          break;
        case "aggregate-maintenance":
          await processAggregateMaintenanceMessage(_env, message.body);
          message.ack();
          break;
        case "dead-letter-reprocessor":
          await processDeadLetterReprocessorMessage(_env, message.body);
          message.ack();
          break;
        default:
          message.retry();
          break;
      }
    } catch {
      message.retry();
    }
  }
}
