export type CommandScope = "workspace" | "table" | "workflow" | "agent-tool";

export type CommandActor = {
  principalId: string;
  mode: "user" | "workflow" | "agent";
};

export type CommandEnvelope = {
  commandId: string;
  workspaceId: string;
  tableId?: string;
  scope: CommandScope;
  commandType: string;
  actor: CommandActor;
  permissionsVersion?: number;
  permissionScopeHash?: string;
  schemaEpoch?: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

export type CommandPermission = {
  allowed: boolean;
  reasons: string[];
};

export type CommandEvent = {
  aggregateId?: string | null;
  aggregateType?: string | null;
  commandId: string;
  commandType: string;
  eventId: string;
  eventType: string;
  tableId: string | null;
  workspaceId: string;
};

export type CommandSideEffect = {
  eventId: string;
  queue: string;
  reason: string;
};

export type CommandReplayProjection = {
  acceptedCommandIds: string[];
  lastLogicalTime: string;
  receiptCount: number;
  receipts: Array<{
    idempotencyKey: string;
    payloadHash: string;
    status: string;
  }>;
};

export type CommandResult = {
  accepted: boolean;
  status: "accepted" | "rejected";
  events: CommandEvent[];
  permission: CommandPermission;
  replayProjection: CommandReplayProjection;
  sideEffects: CommandSideEffect[];
  diagnostics: Array<string>;
};

export type IdempotencyReceipt = {
  idempotencyKey: string;
  payloadHash: string;
  result: CommandResult;
};
