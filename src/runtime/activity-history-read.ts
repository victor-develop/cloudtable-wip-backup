import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import type { ActivityHistoryEntry } from "../core/persistence/types";

export type ActivityHistoryItem = {
  actor: {
    mode: string | null;
    principalId: string | null;
  };
  command: {
    commandId: string;
    commandType: string | null;
  };
  createdAt: string;
  eventId: string;
  eventType: string;
  record: {
    id: string;
    key: string | null;
  } | null;
  sequence: {
    table: number | null;
    workspace: number;
  };
  target:
    | {
        id: string | null;
        type: string;
      }
    | null;
};

export type ActivityHistoryPage = {
  entries: ActivityHistoryItem[];
  nextBeforeTableSequence: number | null;
};

export type WorkspaceActivityHistoryPage = {
  entries: ActivityHistoryItem[];
  nextBeforeWorkspaceSequence: number | null;
};

function sanitizeTarget(entry: ActivityHistoryEntry): ActivityHistoryItem["target"] {
  if (entry.recordId) {
    return {
      id: entry.recordId,
      type: "record"
    };
  }

  switch (entry.aggregateType) {
    case "table":
    case "view":
    case "workflow":
      return {
        id: entry.aggregateId,
        type: entry.aggregateType
      };
    case "field":
    case "cell":
      return {
        id: null,
        type: entry.aggregateType
      };
    default:
      return null;
  }
}

function mapActivityEntry(entry: ActivityHistoryEntry): ActivityHistoryItem {
  return {
    actor: {
      mode: entry.actorMode,
      principalId: entry.actorPrincipalId
    },
    command: {
      commandId: entry.commandId,
      commandType: entry.commandType
    },
    createdAt: entry.createdAt,
    eventId: entry.eventId,
    eventType: entry.eventType,
    record: entry.recordId
      ? {
          id: entry.recordId,
          key: entry.recordKey
        }
      : null,
    sequence: {
      table: entry.tableSequence,
      workspace: entry.workspaceSequence
    },
    target: sanitizeTarget(entry)
  };
}

export async function readTableActivityHistory(
  db: D1Database,
  input: {
    beforeTableSequence?: number | null;
    limit: number;
    tableId: string;
    workspaceId: string;
  }
): Promise<ActivityHistoryPage> {
  const repository = createCloudTableD1Repository(db);
  const entries = await repository.listTableActivity(input);

  return {
    entries: entries.map(mapActivityEntry),
    nextBeforeTableSequence:
      entries.length === input.limit ? entries.at(-1)?.tableSequence ?? null : null
  };
}

export async function readWorkspaceActivityHistory(
  db: D1Database,
  input: {
    beforeWorkspaceSequence?: number | null;
    limit: number;
    workspaceId: string;
  }
): Promise<WorkspaceActivityHistoryPage> {
  const repository = createCloudTableD1Repository(db);
  const entries = await repository.listWorkspaceActivity(input);

  return {
    entries: entries.map(mapActivityEntry),
    nextBeforeWorkspaceSequence:
      entries.length === input.limit ? entries.at(-1)?.workspaceSequence ?? null : null
  };
}

export async function readAppActivityHistory(
  db: D1Database,
  input: {
    appId: string;
    beforeWorkspaceSequence?: number | null;
    limit: number;
    workspaceId: string;
  }
): Promise<WorkspaceActivityHistoryPage> {
  const repository = createCloudTableD1Repository(db);
  const entries = await repository.listAppActivity(input);

  return {
    entries: entries.map(mapActivityEntry),
    nextBeforeWorkspaceSequence:
      entries.length === input.limit ? entries.at(-1)?.workspaceSequence ?? null : null
  };
}

export async function readRecordActivityHistory(
  db: D1Database,
  input: {
    beforeTableSequence?: number | null;
    limit: number;
    recordId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<ActivityHistoryPage> {
  const repository = createCloudTableD1Repository(db);
  const entries = await repository.listRecordActivity(input);

  return {
    entries: entries.map(mapActivityEntry),
    nextBeforeTableSequence:
      entries.length === input.limit ? entries.at(-1)?.tableSequence ?? null : null
  };
}
