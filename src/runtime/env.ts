export type QueueKind =
  | "event-fanout"
  | "workflow-dispatch"
  | "workflow-step"
  | "projection-maintenance"
  | "aggregate-maintenance"
  | "dead-letter-reprocessor";

export type WorkflowStepRetryClass = "standard" | "network";

export type WorkflowStepRetryMetadata = {
  attempt: number;
  delaySeconds: number;
  maxAttempts: number;
  nextAttemptAt: string;
  retryClass: WorkflowStepRetryClass;
};

export type CloudTableQueueMessage = {
  kind: QueueKind;
  eventId?: string;
  payload: Record<string, unknown>;
  retry?: WorkflowStepRetryMetadata;
  workflowRunId?: string;
  workspaceId: string;
};

export type CloudTableEnv = {
  DB: D1Database;
  ARTIFACTS_BUCKET: R2Bucket;
  AUTH_SESSION_SECRET?: string;
  AUTH_ALLOWED_REDIRECT_ORIGINS?: string;
  AUTH_COOKIE_NAME?: string;
  AUTH_SESSION_TTL_SECONDS?: string;
  EVENT_FANOUT_QUEUE: Queue<CloudTableQueueMessage>;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  WORKFLOW_DISPATCH_QUEUE: Queue<CloudTableQueueMessage>;
  WORKFLOW_STEP_QUEUE: Queue<CloudTableQueueMessage>;
  PROJECTION_MAINTENANCE_QUEUE: Queue<CloudTableQueueMessage>;
  AGGREGATE_MAINTENANCE_QUEUE: Queue<CloudTableQueueMessage>;
  DEAD_LETTER_REPROCESSOR_QUEUE: Queue<CloudTableQueueMessage>;
  WORKSPACE_CONTROL_DO: DurableObjectNamespace;
  TABLE_COORDINATOR_DO: DurableObjectNamespace;
};
