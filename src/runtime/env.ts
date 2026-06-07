export type QueueKind =
  | "event-fanout"
  | "workflow-dispatch"
  | "workflow-step"
  | "projection-maintenance"
  | "dead-letter-reprocessor";

export type CloudTableQueueMessage = {
  kind: QueueKind;
  workspaceId: string;
  eventId?: string;
  workflowRunId?: string;
  payload: Record<string, unknown>;
};

export type CloudTableEnv = {
  DB: D1Database;
  ARTIFACTS_BUCKET: R2Bucket;
  EVENT_FANOUT_QUEUE: Queue<CloudTableQueueMessage>;
  WORKFLOW_DISPATCH_QUEUE: Queue<CloudTableQueueMessage>;
  WORKFLOW_STEP_QUEUE: Queue<CloudTableQueueMessage>;
  PROJECTION_MAINTENANCE_QUEUE: Queue<CloudTableQueueMessage>;
  DEAD_LETTER_REPROCESSOR_QUEUE: Queue<CloudTableQueueMessage>;
  WORKSPACE_CONTROL_DO: DurableObjectNamespace;
  TABLE_COORDINATOR_DO: DurableObjectNamespace;
};
