import type { MessageBatch } from "@cloudflare/workers-types";

import type { CloudTableEnv, CloudTableQueueMessage } from "./runtime/env";
import { WorkspaceControlDurableObject } from "./durable-objects/workspace-control";
import { TableCoordinatorDurableObject } from "./durable-objects/table-coordinator";
import { handleQueueBatch } from "./queues/consumer";
import { handleFetch } from "./runtime/worker";

export {
  TableCoordinatorDurableObject,
  WorkspaceControlDurableObject
};

export default {
  async fetch(request: Request, env: CloudTableEnv, ctx: ExecutionContext) {
    return handleFetch(request, env, ctx);
  },
  async queue(
    batch: MessageBatch<CloudTableQueueMessage>,
    env: CloudTableEnv,
    ctx: ExecutionContext
  ) {
    await handleQueueBatch(batch, env, ctx);
  }
};

