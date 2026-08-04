import type { CommandEnvelope } from "../core/commands/types";
import { createAggregateOperationRegistry } from "../core/aggregates/registry";
import type { JsonValue, NormalizedCellValue } from "../core/field-types/types";
import {
  requireWorkflowServiceIdentityMetadata,
  type WorkflowServiceIdentity
} from "../core/workflows/service-identity";
import type { CloudTableEnv, CloudTableQueueMessage } from "./env";

type RoutedAggregateDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  groupingSource: {
    kind: "related_record";
    resolverAlias: string;
    sourceFieldId: string;
  };
  operand?: {
    fieldId: string;
    kind: "source_field";
    valueType: "number";
  };
  operationConfig: Record<string, JsonValue>;
  operationId: string;
  resolver:
    | {
        sourceFieldId: string;
        strategy: "single_relation";
        targetTableId: string;
      }
    | {
        sourceFieldId: string;
        strategy: "value_match";
        targetFieldId: string;
        targetTableId: string;
      };
  sourceRelationPath: string;
  sourceTableId: string;
  targetFieldId: string;
  targetTableId: string;
};

type RoutedLookupDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  lookupSource: {
    kind: "related_record";
    resolverAlias: string;
    sourceFieldId: string;
  };
  resolver: {
    sourceFieldId: string;
    strategy: "single_relation";
    targetTableId: string;
  };
  sourceRelationPath: string;
  sourceTableId: string;
  targetFieldId: string;
  valueFieldId: string;
};

type RoutedSyncDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  resolver:
    | {
        sourceFieldId: string;
        strategy: "single_relation";
        targetTableId: string;
      }
    | {
        sourceFieldId: string;
        strategy: "value_match";
        targetFieldId: string;
        targetTableId: string;
      };
  sourceFieldId: string;
  sourceTableId: string;
  targetFieldId: string;
  targetTableId: string;
};

type AggregateTrigger =
  | {
      kind: "backfill";
      reason: string;
    }
  | {
      changedFieldIds?: string[];
      eventId?: string | null;
      eventType?: string | null;
      kind: "recompute";
      recordId?: string | null;
      targetRecordId?: string | null;
    };

type ParsedMaintenanceMessage =
  | {
      aggregate: RoutedAggregateDefinition;
      trigger: AggregateTrigger;
      workflowId: string;
      workflowVersionId: string;
    }
  | {
      lookup: RoutedLookupDefinition;
      trigger: AggregateTrigger;
      workflowId: string;
      workflowVersionId: string;
    }
  | {
      sync: RoutedSyncDefinition;
      trigger: AggregateTrigger;
      workflowId: string;
      workflowVersionId: string;
    };

type RecordRow = {
  id: string;
};

type WorkflowBackfillJobRow = {
  chunk_size: number;
  cursor_json: string | null;
  processed_count: number;
  status: string;
};

const TERMINAL_BACKFILL_STATUSES = new Set(["abandoned", "completed", "superseded"]);

type BackfillCursor = {
  lastRecordId?: string;
};

type BackfillJobState = {
  chunkSize: number;
  cursor: BackfillCursor;
  processedCount: number;
  status: string;
};

function isTerminalBackfillStatus(status: string): boolean {
  return TERMINAL_BACKFILL_STATUSES.has(status);
}

type RelatedSourceRow = {
  numeric_value?: number | null;
  record_id: string;
  value_json: string | null;
};

type CurrentTargetCellRow = {
  record_id: string;
  value_json: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function parseAggregateMessage(message: CloudTableQueueMessage): ParsedMaintenanceMessage | null {
  const payload = isRecord(message.payload) ? message.payload : null;
  const aggregate = payload && isRecord(payload.aggregate) ? payload.aggregate : null;
  const lookup = payload && isRecord(payload.lookup) ? payload.lookup : null;
  const sync = payload && isRecord(payload.sync) ? payload.sync : null;
  const groupingSource = aggregate && isRecord(aggregate.groupingSource)
    ? aggregate.groupingSource
    : null;
  const lookupSource = lookup && isRecord(lookup.lookupSource) ? lookup.lookupSource : null;
  const resolver = aggregate && isRecord(aggregate.resolver) ? aggregate.resolver : null;
  const lookupResolver = lookup && isRecord(lookup.resolver) ? lookup.resolver : null;
  const syncResolver = sync && isRecord(sync.resolver) ? sync.resolver : null;
  const operand = aggregate && isRecord(aggregate.operand) ? aggregate.operand : null;
  const trigger = payload && isRecord(payload.trigger) ? payload.trigger : null;
  const workflowId = readString(payload?.workflowId);
  const workflowVersionId = readString(payload?.workflowVersionId);

  if (!trigger || !workflowId || !workflowVersionId) {
    return null;
  }

  const parsedAggregate: RoutedAggregateDefinition | null =
    aggregate && groupingSource && resolver
      ? {
          alias: readString(aggregate.alias) ?? "",
          dependencyFieldIds: readStringArray(aggregate.dependencyFieldIds),
          groupingSource: {
            kind: groupingSource.kind === "related_record" ? "related_record" : "related_record",
            resolverAlias: readString(groupingSource.resolverAlias) ?? "",
            sourceFieldId: readString(groupingSource.sourceFieldId) ?? ""
          },
          ...(operand
            ? {
                operand: {
                  fieldId: readString(operand.fieldId) ?? "",
                  kind: operand.kind === "source_field" ? "source_field" : "source_field",
                  valueType: operand.valueType === "number" ? "number" : "number"
                }
              }
            : {}),
          operationConfig: isRecord(aggregate.operationConfig)
            ? (aggregate.operationConfig as Record<string, JsonValue>)
            : {},
          operationId: readString(aggregate.operationId) ?? "",
          resolver:
            resolver.strategy === "value_match"
              ? {
                  sourceFieldId: readString(resolver.sourceFieldId) ?? "",
                  strategy: "value_match",
                  targetFieldId: readString(resolver.targetFieldId) ?? "",
                  targetTableId: readString(resolver.targetTableId) ?? ""
                }
              : {
                  sourceFieldId: readString(resolver.sourceFieldId) ?? "",
                  strategy: "single_relation",
                  targetTableId: readString(resolver.targetTableId) ?? ""
                },
          sourceRelationPath: readString(aggregate.sourceRelationPath) ?? "",
          sourceTableId: readString(aggregate.sourceTableId) ?? "",
          targetFieldId: readString(aggregate.targetFieldId) ?? "",
          targetTableId: readString(aggregate.targetTableId) ?? ""
        }
      : null;

  if (
    parsedAggregate &&
    (parsedAggregate.alias.length === 0 ||
      parsedAggregate.groupingSource.sourceFieldId.length === 0 ||
      parsedAggregate.operationId.length === 0 ||
      parsedAggregate.resolver.sourceFieldId.length === 0 ||
      parsedAggregate.resolver.targetTableId.length === 0 ||
      parsedAggregate.sourceTableId.length === 0 ||
      parsedAggregate.targetFieldId.length === 0 ||
      parsedAggregate.targetTableId.length === 0)
  ) {
    return null;
  }
  if (parsedAggregate?.operand && parsedAggregate.operand.fieldId.length === 0) {
    return null;
  }
  if (
    parsedAggregate?.resolver.strategy === "value_match" &&
    parsedAggregate.resolver.targetFieldId.length === 0
  ) {
    return null;
  }

  const parsedTrigger: AggregateTrigger =
    trigger.kind === "backfill"
      ? {
          kind: "backfill",
          reason: readString(trigger.reason) ?? "unspecified"
        }
      : {
          changedFieldIds: readStringArray(trigger.changedFieldIds),
          eventId: readString(trigger.eventId),
          eventType: readString(trigger.eventType),
          kind: "recompute",
          recordId: readString(trigger.recordId),
          targetRecordId: readString(trigger.targetRecordId)
        };

  if (parsedAggregate) {
    return {
      aggregate: parsedAggregate,
      trigger: parsedTrigger,
      workflowId,
      workflowVersionId
    };
  }

  if (!lookup || !lookupSource || !lookupResolver) {
    if (!sync || !syncResolver) {
      return null;
    }
  }
  if (lookup && lookupSource && lookupResolver) {
    const parsedLookup: RoutedLookupDefinition = {
      alias: readString(lookup.alias) ?? "",
      dependencyFieldIds: readStringArray(lookup.dependencyFieldIds),
      lookupSource: {
        kind: lookupSource.kind === "related_record" ? "related_record" : "related_record",
        resolverAlias: readString(lookupSource.resolverAlias) ?? "",
        sourceFieldId: readString(lookupSource.sourceFieldId) ?? ""
      },
      resolver: {
        sourceFieldId: readString(lookupResolver.sourceFieldId) ?? "",
        strategy: "single_relation",
        targetTableId: readString(lookupResolver.targetTableId) ?? ""
      },
      sourceRelationPath: readString(lookup.sourceRelationPath) ?? "",
      sourceTableId: readString(lookup.sourceTableId) ?? "",
      targetFieldId: readString(lookup.targetFieldId) ?? "",
      valueFieldId: readString(lookup.valueFieldId) ?? ""
    };

    if (
      parsedLookup.alias.length === 0 ||
      parsedLookup.lookupSource.resolverAlias.length === 0 ||
      parsedLookup.lookupSource.sourceFieldId.length === 0 ||
      parsedLookup.resolver.sourceFieldId.length === 0 ||
      parsedLookup.resolver.targetTableId.length === 0 ||
      parsedLookup.sourceRelationPath.length === 0 ||
      parsedLookup.sourceTableId.length === 0 ||
      parsedLookup.targetFieldId.length === 0 ||
      parsedLookup.valueFieldId.length === 0
    ) {
      return null;
    }

    return {
      lookup: parsedLookup,
      trigger: parsedTrigger,
      workflowId,
      workflowVersionId
    };
  }

  const parsedSync: RoutedSyncDefinition = {
    alias: readString(sync?.alias) ?? "",
    dependencyFieldIds: readStringArray(sync?.dependencyFieldIds),
    resolver:
      syncResolver?.strategy === "value_match"
        ? {
            sourceFieldId: readString(syncResolver.sourceFieldId) ?? "",
            strategy: "value_match",
            targetFieldId: readString(syncResolver.targetFieldId) ?? "",
            targetTableId: readString(syncResolver.targetTableId) ?? ""
          }
        : {
            sourceFieldId: readString(syncResolver?.sourceFieldId) ?? "",
            strategy: "single_relation",
            targetTableId: readString(syncResolver?.targetTableId) ?? ""
          },
    sourceFieldId: readString(sync?.sourceFieldId) ?? "",
    sourceTableId: readString(sync?.sourceTableId) ?? "",
    targetFieldId: readString(sync?.targetFieldId) ?? "",
    targetTableId: readString(sync?.targetTableId) ?? ""
  };
  if (
    parsedSync.alias.length === 0 ||
    parsedSync.resolver.sourceFieldId.length === 0 ||
    parsedSync.sourceFieldId.length === 0 ||
    parsedSync.sourceTableId.length === 0 ||
    parsedSync.targetFieldId.length === 0 ||
    parsedSync.targetTableId.length === 0
  ) {
    return null;
  }
  if (
    parsedSync.resolver.strategy === "value_match" &&
    parsedSync.resolver.targetFieldId.length === 0
  ) {
    return null;
  }

  return {
    sync: parsedSync,
    trigger: parsedTrigger,
    workflowId,
    workflowVersionId
  };
}

function parseRelatedTargetId(valueJson: string | null): string | null {
  if (!valueJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(valueJson) as NormalizedCellValue | null;
    const raw = parsed?.raw;
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }

    if (Array.isArray(raw)) {
      const first = raw.find(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      );
      return first ?? null;
    }
  } catch {
    return null;
  }

  return null;
}

function parseScalarCellValue(valueJson: string | null): JsonValue | null {
  if (!valueJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(valueJson) as NormalizedCellValue | null;
    const raw = parsed?.raw;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      return raw;
    }
  } catch {
    return null;
  }

  return null;
}

function parseRawCellValue(valueJson: string | null): JsonValue | null {
  if (!valueJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(valueJson) as NormalizedCellValue | null;
    return (parsed?.raw ?? null) as JsonValue | null;
  } catch {
    return null;
  }
}

function scalarMatchKey(value: JsonValue | null): string | null {
  if (typeof value === "string") {
    return `string:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${String(value)}`;
  }
  if (typeof value === "boolean") {
    return `boolean:${value ? "true" : "false"}`;
  }

  return null;
}

async function loadActiveRecordIds(
  db: D1Database,
  workspaceId: string,
  tableId: string
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT id
       FROM records
       WHERE workspace_id = ? AND table_id = ? AND archived_at IS NULL
       ORDER BY id ASC`
    )
    .bind(workspaceId, tableId)
    .all<RecordRow>();

  return (rows.results ?? []).map((row) => row.id);
}

async function loadActiveRecordIdChunk(
  db: D1Database,
  input: {
    afterRecordId?: string;
    limit: number;
    tableId: string;
    workspaceId: string;
  }
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT id
       FROM records
       WHERE workspace_id = ?
         AND table_id = ?
         AND archived_at IS NULL
         AND (? IS NULL OR id > ?)
       ORDER BY id ASC
       LIMIT ?`
    )
    .bind(
      input.workspaceId,
      input.tableId,
      input.afterRecordId ?? null,
      input.afterRecordId ?? null,
      input.limit
    )
    .all<RecordRow>();

  return (rows.results ?? []).map((row) => row.id);
}

async function loadRelatedSourceRows(
  db: D1Database,
  workspaceId: string,
  aggregate: RoutedAggregateDefinition,
  sourceRecordIds?: readonly string[]
): Promise<Array<{ numericValue: number | null; recordId: string; targetRecordId: string | null }>> {
  const operandFieldId = aggregate.operand?.fieldId ?? null;
  const sourceRecordFilter =
    sourceRecordIds && sourceRecordIds.length > 0
      ? {
          clause: ` AND records.id IN (${sourceRecordIds.map(() => "?").join(", ")})`,
          values: [...sourceRecordIds]
        }
      : { clause: "", values: [] as string[] };

  if (aggregate.resolver.strategy === "value_match") {
    const [sourceRows, targetRows] = await Promise.all([
      db
        .prepare(
          `SELECT
             records.id AS record_id,
             group_cell.value_json AS value_json,
             operand_cell.number_value AS numeric_value
           FROM records
           LEFT JOIN cell_current AS group_cell
             ON group_cell.workspace_id = records.workspace_id
            AND group_cell.table_id = records.table_id
            AND group_cell.record_id = records.id
            AND group_cell.field_id = ?
           LEFT JOIN cell_current AS operand_cell
             ON operand_cell.workspace_id = records.workspace_id
            AND operand_cell.table_id = records.table_id
            AND operand_cell.record_id = records.id
            AND operand_cell.field_id = ?
           WHERE records.workspace_id = ?
             AND records.table_id = ?
             AND records.archived_at IS NULL${sourceRecordFilter.clause}
           ORDER BY records.id ASC`
        )
        .bind(
          aggregate.resolver.sourceFieldId,
          operandFieldId,
          workspaceId,
          aggregate.sourceTableId,
          ...sourceRecordFilter.values
        )
        .all<RelatedSourceRow>(),
      db
        .prepare(
          `SELECT
             records.id AS record_id,
             cell_current.value_json AS value_json
           FROM records
           LEFT JOIN cell_current
             ON cell_current.workspace_id = records.workspace_id
            AND cell_current.table_id = records.table_id
            AND cell_current.record_id = records.id
            AND cell_current.field_id = ?
           WHERE records.workspace_id = ?
             AND records.table_id = ?
             AND records.archived_at IS NULL
           ORDER BY records.id ASC`
        )
        .bind(aggregate.resolver.targetFieldId, workspaceId, aggregate.targetTableId)
        .all<RelatedSourceRow>()
    ]);

    const targetRecordIdsByValue = new Map<string, string[]>();
    for (const row of targetRows.results ?? []) {
      const key = scalarMatchKey(parseScalarCellValue(row.value_json));
      if (!key) {
        continue;
      }

      const recordIds = targetRecordIdsByValue.get(key) ?? [];
      recordIds.push(row.record_id);
      targetRecordIdsByValue.set(key, recordIds);
    }

    return (sourceRows.results ?? []).reduce<
      Array<{ numericValue: number | null; recordId: string; targetRecordId: string | null }>
    >((resolved, row) => {
        const key = scalarMatchKey(parseScalarCellValue(row.value_json));
        const matchedTargetRecordIds = key ? (targetRecordIdsByValue.get(key) ?? []) : [];
        if (matchedTargetRecordIds.length === 0) {
          resolved.push({
            numericValue: Number.isFinite(row.numeric_value) ? row.numeric_value ?? null : null,
            recordId: row.record_id,
            targetRecordId: null
          });
          return resolved;
        }

        for (const targetRecordId of matchedTargetRecordIds) {
          resolved.push({
            numericValue: Number.isFinite(row.numeric_value) ? row.numeric_value ?? null : null,
            recordId: row.record_id,
            targetRecordId
          });
        }

        return resolved;
      }, []);
  }

  const rows = await db
    .prepare(
      `SELECT
         records.id AS record_id,
         group_cell.value_json AS value_json,
         operand_cell.number_value AS numeric_value
       FROM records
       LEFT JOIN cell_current AS group_cell
         ON group_cell.workspace_id = records.workspace_id
        AND group_cell.table_id = records.table_id
        AND group_cell.record_id = records.id
        AND group_cell.field_id = ?
       LEFT JOIN cell_current AS operand_cell
         ON operand_cell.workspace_id = records.workspace_id
        AND operand_cell.table_id = records.table_id
        AND operand_cell.record_id = records.id
        AND operand_cell.field_id = ?
       WHERE records.workspace_id = ?
         AND records.table_id = ?
         AND records.archived_at IS NULL${sourceRecordFilter.clause}
       ORDER BY records.id ASC`
    )
    .bind(
      aggregate.resolver.sourceFieldId,
      operandFieldId,
      workspaceId,
      aggregate.sourceTableId,
      ...sourceRecordFilter.values
    )
    .all<RelatedSourceRow>();

  return (rows.results ?? []).map((row) => ({
    numericValue: Number.isFinite(row.numeric_value) ? row.numeric_value ?? null : null,
    recordId: row.record_id,
    targetRecordId: parseRelatedTargetId(row.value_json)
  }));
}

async function loadCurrentTargetFieldValues(
  db: D1Database,
  workspaceId: string,
  aggregate: RoutedAggregateDefinition
): Promise<Map<string, JsonValue | null>> {
  const rows = await db
    .prepare(
      `SELECT record_id, value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND field_id = ?`
    )
    .bind(workspaceId, aggregate.targetTableId, aggregate.targetFieldId)
    .all<CurrentTargetCellRow>();

  return new Map(
    (rows.results ?? []).map((row) => {
      try {
        const parsed = JSON.parse(row.value_json) as NormalizedCellValue | null;
        return [row.record_id, parsed?.raw ?? null] as const;
      } catch {
        return [row.record_id, null] as const;
      }
    })
  );
}

async function loadLookupCurrentFieldValues(
  db: D1Database,
  workspaceId: string,
  lookup: RoutedLookupDefinition
): Promise<Map<string, JsonValue | null>> {
  const rows = await db
    .prepare(
      `SELECT record_id, value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND field_id = ?`
    )
    .bind(workspaceId, lookup.sourceTableId, lookup.targetFieldId)
    .all<CurrentTargetCellRow>();

  return new Map(
    (rows.results ?? []).map((row) => [row.record_id, parseRawCellValue(row.value_json)] as const)
  );
}

async function loadLookupNextValue(
  db: D1Database,
  workspaceId: string,
  lookup: RoutedLookupDefinition,
  sourceRecordId: string
): Promise<JsonValue | null> {
  const sourceRelation = await db
    .prepare(
      `SELECT value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
    )
    .bind(workspaceId, lookup.sourceTableId, sourceRecordId, lookup.resolver.sourceFieldId)
    .first<{ value_json: string | null }>();

  const relatedRecordId = parseRelatedTargetId(sourceRelation?.value_json ?? null);
  if (!relatedRecordId) {
    return null;
  }

  const relatedValue = await db
    .prepare(
      `SELECT value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
    )
    .bind(workspaceId, lookup.resolver.targetTableId, relatedRecordId, lookup.valueFieldId)
    .first<{ value_json: string | null }>();

  return parseRawCellValue(relatedValue?.value_json ?? null);
}

async function loadLookupSourceRecordIdsForTargetRecord(
  db: D1Database,
  workspaceId: string,
  lookup: RoutedLookupDefinition,
  targetRecordId: string
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT
         records.id AS record_id,
         cell_current.value_json AS value_json
       FROM records
       LEFT JOIN cell_current
         ON cell_current.workspace_id = records.workspace_id
        AND cell_current.table_id = records.table_id
        AND cell_current.record_id = records.id
        AND cell_current.field_id = ?
       WHERE records.workspace_id = ?
         AND records.table_id = ?
         AND records.archived_at IS NULL
       ORDER BY records.id ASC`
    )
    .bind(lookup.resolver.sourceFieldId, workspaceId, lookup.sourceTableId)
    .all<{ record_id: string; value_json: string | null }>();

  return (rows.results ?? [])
    .filter((row) => {
      const raw = parseRawCellValue(row.value_json);
      const relatedRecordIds = Array.isArray(raw) ? raw : [raw];
      return relatedRecordIds.includes(targetRecordId);
    })
    .map((row) => row.record_id);
}

type SyncSourceRow = {
  match_value_json?: string | null;
  record_id: string;
  source_value_json?: string | null;
};

async function loadSyncTargetFieldValues(
  db: D1Database,
  workspaceId: string,
  sync: RoutedSyncDefinition
): Promise<Map<string, JsonValue | null>> {
  const rows = await db
    .prepare(
      `SELECT record_id, value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND field_id = ?`
    )
    .bind(workspaceId, sync.targetTableId, sync.targetFieldId)
    .all<CurrentTargetCellRow>();

  return new Map(
    (rows.results ?? []).map((row) => [row.record_id, parseRawCellValue(row.value_json)] as const)
  );
}

async function loadSyncTargetRecordIdsByMatchKey(
  db: D1Database,
  workspaceId: string,
  sync: RoutedSyncDefinition & {
    resolver: {
      sourceFieldId: string;
      strategy: "value_match";
      targetFieldId: string;
      targetTableId: string;
    };
  }
): Promise<Map<string, string[]>> {
  const targetRows = await db
    .prepare(
      `SELECT
         records.id AS record_id,
         cell_current.value_json AS value_json
       FROM records
       LEFT JOIN cell_current
         ON cell_current.workspace_id = records.workspace_id
        AND cell_current.table_id = records.table_id
        AND cell_current.record_id = records.id
        AND cell_current.field_id = ?
       WHERE records.workspace_id = ?
         AND records.table_id = ?
         AND records.archived_at IS NULL
       ORDER BY records.id ASC`
    )
    .bind(sync.resolver.targetFieldId, workspaceId, sync.targetTableId)
    .all<{ record_id: string; value_json: string | null }>();

  const targetRecordIdsByKey = new Map<string, string[]>();
  for (const row of targetRows.results ?? []) {
    const key = scalarMatchKey(parseScalarCellValue(row.value_json));
    if (!key) {
      continue;
    }

    const recordIds = targetRecordIdsByKey.get(key) ?? [];
    recordIds.push(row.record_id);
    targetRecordIdsByKey.set(key, recordIds);
  }

  return targetRecordIdsByKey;
}

async function loadSyncSourceRows(
  db: D1Database,
  workspaceId: string,
  sync: RoutedSyncDefinition,
  sourceRecordIds?: readonly string[]
): Promise<SyncSourceRow[]> {
  const sourceRecordFilter =
    sourceRecordIds && sourceRecordIds.length > 0
      ? {
          clause: ` AND records.id IN (${sourceRecordIds.map(() => "?").join(", ")})`,
          values: [...sourceRecordIds]
        }
      : { clause: "", values: [] as string[] };

  const matchFieldId = sync.resolver.sourceFieldId;
  const rows = await db
    .prepare(
      `SELECT
         records.id AS record_id,
         source_cell.value_json AS source_value_json,
         match_cell.value_json AS match_value_json
       FROM records
       LEFT JOIN cell_current AS source_cell
         ON source_cell.workspace_id = records.workspace_id
        AND source_cell.table_id = records.table_id
        AND source_cell.record_id = records.id
        AND source_cell.field_id = ?
       LEFT JOIN cell_current AS match_cell
         ON match_cell.workspace_id = records.workspace_id
        AND match_cell.table_id = records.table_id
        AND match_cell.record_id = records.id
        AND match_cell.field_id = ?
       WHERE records.workspace_id = ?
         AND records.table_id = ?
         AND records.archived_at IS NULL${sourceRecordFilter.clause}
       ORDER BY records.id ASC`
    )
    .bind(
      sync.sourceFieldId,
      matchFieldId,
      workspaceId,
      sync.sourceTableId,
      ...sourceRecordFilter.values
    )
    .all<SyncSourceRow>();

  return rows.results ?? [];
}

async function loadFieldType(
  db: D1Database,
  input: { fieldId: string; tableId: string; workspaceId: string }
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT field_type
       FROM fields
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(input.workspaceId, input.tableId, input.fieldId)
    .first<{ field_type: string }>();

  if (!row?.field_type) {
    throw new Error(
      `Field ${input.fieldId} was not found on table ${input.tableId} for maintenance dispatch.`
    );
  }

  return row.field_type;
}

async function dispatchCoordinatorOwnedCellSet(
  env: CloudTableEnv,
  command: CommandEnvelope
): Promise<void> {
  const id = env.TABLE_COORDINATOR_DO.idFromName(`${command.workspaceId}:${command.tableId}`);
  const stub = env.TABLE_COORDINATOR_DO.get(id);
  const response = await stub.fetch(
    new Request("https://cloudtable.internal/internal/aggregate-maintenance", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ command })
    })
  );

  if (!response.ok) {
    throw new Error(`Aggregate maintenance coordinator write failed: ${response.status}`);
  }
}

async function loadWorkflowServiceIdentity(
  env: CloudTableEnv,
  input: { workflowId: string; workflowVersionId: string; workspaceId: string }
): Promise<WorkflowServiceIdentity> {
  const row = await env.DB.prepare(
    `SELECT definition_json
     FROM workflow_versions
     WHERE workspace_id = ? AND id = ?`
  )
    .bind(input.workspaceId, input.workflowVersionId)
    .first<{ definition_json: string }>();
  if (!row) {
    throw new Error(
      `Workflow ${input.workflowId} version ${input.workflowVersionId} was not found for aggregate maintenance in workspace ${input.workspaceId}.`
    );
  }

  let definition: unknown;
  try {
    definition = JSON.parse(row.definition_json);
  } catch {
    throw new Error(
      `Workflow ${input.workflowId} version ${input.workflowVersionId} has malformed persisted definition JSON and cannot resolve explicit workflow service identity metadata.`
    );
  }

  return requireWorkflowServiceIdentityMetadata(definition, input);
}

function applyWorkflowServiceIdentity(
  identity: WorkflowServiceIdentity
): Pick<CommandEnvelope, "actor" | "permissionScopeHash" | "permissionsVersion" | "schemaEpoch"> {
  return {
    actor: {
      mode: "workflow",
      principalId: identity.principalId
    },
    permissionScopeHash: identity.scopeHash,
    permissionsVersion: identity.policyRevision,
    schemaEpoch: identity.schemaEpoch
  };
}

function commandIdentityForTarget(
  input: {
    aggregate: RoutedAggregateDefinition;
    targetRecordId: string;
    trigger: AggregateTrigger;
    workflowId: string;
    workflowVersionId: string;
  }
): { commandId: string; idempotencyKey: string } {
  const triggerIdentity =
    input.trigger.kind === "backfill"
      ? `backfill:${input.trigger.reason}`
      : `recompute:${input.trigger.eventId ?? "manual"}`;
  const baseKey = [
    "aggregate-maintenance",
    input.workflowVersionId,
    input.aggregate.alias,
    input.targetRecordId,
    triggerIdentity
  ].join(":");

  return {
    commandId: `cmd:${baseKey}`,
    idempotencyKey: `idem:${baseKey}`
  };
}

function commandIdentityForLookupTarget(
  input: {
    lookup: RoutedLookupDefinition;
    sourceRecordId: string;
    trigger: AggregateTrigger;
    workflowVersionId: string;
  }
): { commandId: string; idempotencyKey: string } {
  const triggerIdentity =
    input.trigger.kind === "backfill"
      ? `backfill:${input.trigger.reason}`
      : `recompute:${input.trigger.eventId ?? "manual"}`;
  const baseKey = [
    "lookup-maintenance",
    input.workflowVersionId,
    input.lookup.alias,
    input.sourceRecordId,
    triggerIdentity
  ].join(":");

  return {
    commandId: `cmd:${baseKey}`,
    idempotencyKey: `idem:${baseKey}`
  };
}

function commandIdentityForSyncTarget(
  input: {
    sourceRecordId: string;
    sync: RoutedSyncDefinition;
    targetRecordId: string;
    trigger: AggregateTrigger;
    workflowVersionId: string;
  }
): { commandId: string; idempotencyKey: string } {
  const triggerIdentity =
    input.trigger.kind === "backfill"
      ? `backfill:${input.trigger.reason}`
      : `recompute:${input.trigger.eventId ?? "manual"}`;
  const baseKey = [
    "sync-maintenance",
    input.workflowVersionId,
    input.sync.alias,
    input.sourceRecordId,
    input.targetRecordId,
    triggerIdentity
  ].join(":");

  return {
    commandId: `cmd:${baseKey}`,
    idempotencyKey: `idem:${baseKey}`
  };
}

async function markBackfillJobRunning(
  db: D1Database,
  input: {
    alias: string;
    dependencyKind: "aggregate" | "lookup" | "sync";
    reason: string;
    workflowVersionId: string;
    workspaceId: string;
  }
): Promise<BackfillJobState | null> {
  const row = await db
    .prepare(
      `SELECT chunk_size, cursor_json, processed_count, status
       FROM workflow_backfill_jobs
       WHERE workspace_id = ?
         AND workflow_version_id = ?
         AND dependency_kind = ?
         AND dependency_alias = ?
         AND reason = ?`
    )
    .bind(
      input.workspaceId,
      input.workflowVersionId,
      input.dependencyKind,
      input.alias,
      input.reason
    )
    .first<WorkflowBackfillJobRow>();
  if (!row) {
    return null;
  }
  if (isTerminalBackfillStatus(row.status)) {
    return {
      chunkSize: Math.max(1, row.chunk_size),
      cursor: parseBackfillCursor(row.cursor_json),
      processedCount: row.processed_count,
      status: row.status
    };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             last_error = NULL,
             updated_at = ?
         WHERE workspace_id = ?
           AND workflow_version_id = ?
           AND dependency_kind = ?
           AND dependency_alias = ?
           AND reason = ?
           AND status NOT IN ('abandoned', 'completed', 'superseded')`
      )
      .bind(
        new Date().toISOString(),
        input.workspaceId,
        input.workflowVersionId,
        input.dependencyKind,
        input.alias,
        input.reason
      )
  ]);

  return {
    chunkSize: Math.max(1, row.chunk_size),
    cursor: parseBackfillCursor(row.cursor_json),
    processedCount: row.processed_count,
    status: "running"
  };
}

async function markBackfillJobCompleted(
  db: D1Database,
  input: {
    alias: string;
    dependencyKind: "aggregate" | "lookup" | "sync";
    processedCount: number;
    reason: string;
    workflowVersionId: string;
    workspaceId: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = 'completed',
             processed_count = ?,
             cursor_json = NULL,
             last_error = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE workspace_id = ?
           AND workflow_version_id = ?
           AND dependency_kind = ?
           AND dependency_alias = ?
           AND reason = ?`
      )
      .bind(
        input.processedCount,
        now,
        now,
        input.workspaceId,
        input.workflowVersionId,
        input.dependencyKind,
        input.alias,
        input.reason
      )
  ]);
}

function parseBackfillCursor(cursorJson: string | null): BackfillCursor {
  if (!cursorJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(cursorJson) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return typeof parsed.lastRecordId === "string" && parsed.lastRecordId.length > 0
      ? { lastRecordId: parsed.lastRecordId }
      : {};
  } catch {
    return {};
  }
}

async function markBackfillJobChunkProgress(
  db: D1Database,
  input: {
    alias: string;
    dependencyKind: "aggregate" | "lookup" | "sync";
    lastRecordId: string;
    processedCount: number;
    reason: string;
    workflowVersionId: string;
    workspaceId: string;
  }
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = 'queued',
             processed_count = processed_count + ?,
             cursor_json = ?,
             last_error = NULL,
             updated_at = ?
         WHERE workspace_id = ?
           AND workflow_version_id = ?
           AND dependency_kind = ?
           AND dependency_alias = ?
           AND reason = ?
           AND status NOT IN ('abandoned', 'completed', 'superseded')`
      )
      .bind(
        input.processedCount,
        JSON.stringify({ lastRecordId: input.lastRecordId }),
        new Date().toISOString(),
        input.workspaceId,
        input.workflowVersionId,
        input.dependencyKind,
        input.alias,
        input.reason
      )
  ]);
}

async function markBackfillJobFailed(
  db: D1Database,
  input: {
    alias: string;
    dependencyKind: "aggregate" | "lookup" | "sync";
    error: unknown;
    reason: string;
    workflowVersionId: string;
    workspaceId: string;
  }
): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await db.batch([
    db
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = 'queued',
             last_error = ?,
             updated_at = ?
         WHERE workspace_id = ?
           AND workflow_version_id = ?
           AND dependency_kind = ?
           AND dependency_alias = ?
           AND reason = ?
           AND status NOT IN ('abandoned', 'completed', 'superseded')`
      )
      .bind(
        message,
        new Date().toISOString(),
        input.workspaceId,
        input.workflowVersionId,
        input.dependencyKind,
        input.alias,
        input.reason
      )
  ]);
}

async function enqueueNextBackfillChunk(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  await env.AGGREGATE_MAINTENANCE_QUEUE.send(message);
}

export async function processAggregateMaintenanceMessage(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const parsed = parseAggregateMessage(message);
  if (!parsed) {
    return;
  }

  const workflowServiceIdentity = await loadWorkflowServiceIdentity(env, {
    workflowId: parsed.workflowId,
    workflowVersionId: parsed.workflowVersionId,
    workspaceId: message.workspaceId
  });

  if ("lookup" in parsed) {
    let backfillJob: BackfillJobState | null = null;
    if (parsed.trigger.kind === "backfill") {
      backfillJob = await markBackfillJobRunning(env.DB, {
        alias: parsed.lookup.alias,
        dependencyKind: "lookup",
        reason: parsed.trigger.reason,
        workflowVersionId: parsed.workflowVersionId,
        workspaceId: message.workspaceId
      });
      if (backfillJob && isTerminalBackfillStatus(backfillJob.status)) {
        return;
      }
    }
    const sourceRecordIdsWithSentinel =
      parsed.trigger.kind === "backfill" && backfillJob
        ? await loadActiveRecordIdChunk(env.DB, {
            afterRecordId: backfillJob.cursor.lastRecordId,
            limit: backfillJob.chunkSize + 1,
            tableId: parsed.lookup.sourceTableId,
            workspaceId: message.workspaceId
          })
        : parsed.trigger.kind === "recompute" && parsed.trigger.recordId
          ? [parsed.trigger.recordId]
          : parsed.trigger.kind === "recompute" && parsed.trigger.targetRecordId
            ? await loadLookupSourceRecordIdsForTargetRecord(
                env.DB,
                message.workspaceId,
                parsed.lookup,
                parsed.trigger.targetRecordId
              )
          : await loadActiveRecordIds(env.DB, message.workspaceId, parsed.lookup.sourceTableId);
    const sourceRecordIds =
      parsed.trigger.kind === "backfill" && backfillJob
        ? sourceRecordIdsWithSentinel.slice(0, backfillJob.chunkSize)
        : sourceRecordIdsWithSentinel;
    const hasMoreBackfillRecords =
      parsed.trigger.kind === "backfill" &&
      backfillJob !== null &&
      sourceRecordIdsWithSentinel.length > backfillJob.chunkSize;

    try {
      const [activeSourceRecordIds, currentValues] = await Promise.all([
        loadActiveRecordIds(env.DB, message.workspaceId, parsed.lookup.sourceTableId),
        loadLookupCurrentFieldValues(env.DB, message.workspaceId, parsed.lookup)
      ]);
      const activeSourceRecordIdSet = new Set(activeSourceRecordIds);

      for (const sourceRecordId of sourceRecordIds) {
        if (!activeSourceRecordIdSet.has(sourceRecordId)) {
          continue;
        }

        const nextValue = await loadLookupNextValue(
          env.DB,
          message.workspaceId,
          parsed.lookup,
          sourceRecordId
        );
        const currentValue = currentValues.get(sourceRecordId) ?? null;
        if (JSON.stringify(currentValue) === JSON.stringify(nextValue)) {
          continue;
        }

        const identity = commandIdentityForLookupTarget({
          lookup: parsed.lookup,
          sourceRecordId,
          trigger: parsed.trigger,
          workflowVersionId: parsed.workflowVersionId
        });
        await dispatchCoordinatorOwnedCellSet(env, {
          ...applyWorkflowServiceIdentity(workflowServiceIdentity),
          commandId: identity.commandId,
          commandType: "cell.set",
          idempotencyKey: identity.idempotencyKey,
          payload: {
            fieldId: parsed.lookup.targetFieldId,
            fieldType: "computed.readonly",
            recordId: sourceRecordId,
            value: nextValue
          },
          scope: "table",
          tableId: parsed.lookup.sourceTableId,
          workspaceId: message.workspaceId
        });
      }

      if (parsed.trigger.kind === "backfill") {
        if (backfillJob) {
          if (hasMoreBackfillRecords && sourceRecordIds.length > 0) {
            await markBackfillJobChunkProgress(env.DB, {
              alias: parsed.lookup.alias,
              dependencyKind: "lookup",
              lastRecordId: sourceRecordIds[sourceRecordIds.length - 1]!,
              processedCount: sourceRecordIds.length,
              reason: parsed.trigger.reason,
              workflowVersionId: parsed.workflowVersionId,
              workspaceId: message.workspaceId
            });
            await enqueueNextBackfillChunk(env, message);
          } else {
            await markBackfillJobCompleted(env.DB, {
              alias: parsed.lookup.alias,
              dependencyKind: "lookup",
              processedCount: backfillJob.processedCount + sourceRecordIds.length,
              reason: parsed.trigger.reason,
              workflowVersionId: parsed.workflowVersionId,
              workspaceId: message.workspaceId
            });
          }
        } else {
          await markBackfillJobCompleted(env.DB, {
            alias: parsed.lookup.alias,
            dependencyKind: "lookup",
            processedCount: sourceRecordIds.length,
            reason: parsed.trigger.reason,
            workflowVersionId: parsed.workflowVersionId,
            workspaceId: message.workspaceId
          });
        }
      }
    } catch (error) {
      if (parsed.trigger.kind === "backfill" && backfillJob) {
        await markBackfillJobFailed(env.DB, {
          alias: parsed.lookup.alias,
          dependencyKind: "lookup",
          error,
          reason: parsed.trigger.reason,
          workflowVersionId: parsed.workflowVersionId,
          workspaceId: message.workspaceId
        });
      }
      throw error;
    }
    return;
  }

  if ("sync" in parsed) {
    let backfillJob: BackfillJobState | null = null;
    if (parsed.trigger.kind === "backfill") {
      backfillJob = await markBackfillJobRunning(env.DB, {
        alias: parsed.sync.alias,
        dependencyKind: "sync",
        reason: parsed.trigger.reason,
        workflowVersionId: parsed.workflowVersionId,
        workspaceId: message.workspaceId
      });
      if (backfillJob && isTerminalBackfillStatus(backfillJob.status)) {
        return;
      }
    }
    const sourceRecordIdsWithSentinel =
      parsed.trigger.kind === "backfill" && backfillJob
        ? await loadActiveRecordIdChunk(env.DB, {
            afterRecordId: backfillJob.cursor.lastRecordId,
            limit: backfillJob.chunkSize + 1,
            tableId: parsed.sync.sourceTableId,
            workspaceId: message.workspaceId
          })
        : undefined;
    const scopedSourceRecordIds =
      parsed.trigger.kind === "backfill" && backfillJob
        ? sourceRecordIdsWithSentinel!.slice(0, backfillJob.chunkSize)
        : parsed.trigger.kind === "recompute" && parsed.trigger.recordId
          ? [parsed.trigger.recordId]
          : undefined;
    const hasMoreBackfillRecords =
      parsed.trigger.kind === "backfill" &&
      backfillJob !== null &&
      sourceRecordIdsWithSentinel !== undefined &&
      sourceRecordIdsWithSentinel.length > backfillJob.chunkSize;

    try {
      const targetFieldType = await loadFieldType(env.DB, {
        fieldId: parsed.sync.targetFieldId,
        tableId: parsed.sync.targetTableId,
        workspaceId: message.workspaceId
      });
      const [currentValues, sourceRows] = await Promise.all([
        loadSyncTargetFieldValues(env.DB, message.workspaceId, parsed.sync),
        loadSyncSourceRows(env.DB, message.workspaceId, parsed.sync, scopedSourceRecordIds)
      ]);
      const targetRecordIdsByMatchKey =
        parsed.sync.resolver.strategy === "value_match"
          ? await loadSyncTargetRecordIdsByMatchKey(
              env.DB,
              message.workspaceId,
              parsed.sync as RoutedSyncDefinition & {
                resolver: {
                  sourceFieldId: string;
                  strategy: "value_match";
                  targetFieldId: string;
                  targetTableId: string;
                };
              }
            )
          : null;
      const reconciledTargetRecordIds = new Set<string>();

      for (const row of sourceRows) {
        const sourceValue = parseRawCellValue(row.source_value_json ?? null);
        const targetRecordIds =
          parsed.sync.resolver.strategy === "single_relation"
            ? Array.from(
                new Set(
                  (Array.isArray(parseRawCellValue(row.match_value_json ?? null))
                    ? (parseRawCellValue(row.match_value_json ?? null) as JsonValue[])
                    : [parseRawCellValue(row.match_value_json ?? null)]
                  ).filter(
                    (recordId): recordId is string =>
                      typeof recordId === "string" && recordId.length > 0
                  )
                )
              ).sort()
            : (targetRecordIdsByMatchKey?.get(
                scalarMatchKey(parseScalarCellValue(row.match_value_json ?? null)) ?? "__missing__"
              ) ?? []);

        for (const targetRecordId of targetRecordIds) {
          if (
            parsed.trigger.kind === "recompute" &&
            parsed.trigger.targetRecordId &&
            targetRecordId !== parsed.trigger.targetRecordId
          ) {
            continue;
          }

          reconciledTargetRecordIds.add(targetRecordId);
          const currentValue = currentValues.get(targetRecordId) ?? null;
          if (JSON.stringify(currentValue) === JSON.stringify(sourceValue)) {
            continue;
          }

          const identity = commandIdentityForSyncTarget({
            sourceRecordId: row.record_id,
            sync: parsed.sync,
            targetRecordId,
            trigger: parsed.trigger,
            workflowVersionId: parsed.workflowVersionId
          });
          await dispatchCoordinatorOwnedCellSet(env, {
            ...applyWorkflowServiceIdentity(workflowServiceIdentity),
            commandId: identity.commandId,
            commandType: "cell.set",
            idempotencyKey: identity.idempotencyKey,
            payload: {
              fieldId: parsed.sync.targetFieldId,
              fieldType: targetFieldType,
              recordId: targetRecordId,
              value: sourceValue
            },
            scope: "table",
            tableId: parsed.sync.targetTableId,
            workspaceId: message.workspaceId
          });
        }
      }

      if (
        parsed.trigger.kind === "recompute" &&
        parsed.trigger.targetRecordId &&
        !reconciledTargetRecordIds.has(parsed.trigger.targetRecordId)
      ) {
        const currentValue = currentValues.get(parsed.trigger.targetRecordId) ?? null;
        if (currentValue !== null) {
          const identity = commandIdentityForSyncTarget({
            sourceRecordId: `target:${parsed.trigger.targetRecordId}`,
            sync: parsed.sync,
            targetRecordId: parsed.trigger.targetRecordId,
            trigger: parsed.trigger,
            workflowVersionId: parsed.workflowVersionId
          });
          await dispatchCoordinatorOwnedCellSet(env, {
            ...applyWorkflowServiceIdentity(workflowServiceIdentity),
            commandId: identity.commandId,
            commandType: "cell.set",
            idempotencyKey: identity.idempotencyKey,
            payload: {
              fieldId: parsed.sync.targetFieldId,
              fieldType: targetFieldType,
              recordId: parsed.trigger.targetRecordId,
              value: null
            },
            scope: "table",
            tableId: parsed.sync.targetTableId,
            workspaceId: message.workspaceId
          });
        }
      }

      if (parsed.trigger.kind === "backfill") {
        if (backfillJob && scopedSourceRecordIds) {
          if (hasMoreBackfillRecords && scopedSourceRecordIds.length > 0) {
            await markBackfillJobChunkProgress(env.DB, {
              alias: parsed.sync.alias,
              dependencyKind: "sync",
              lastRecordId: scopedSourceRecordIds[scopedSourceRecordIds.length - 1]!,
              processedCount: scopedSourceRecordIds.length,
              reason: parsed.trigger.reason,
              workflowVersionId: parsed.workflowVersionId,
              workspaceId: message.workspaceId
            });
            await enqueueNextBackfillChunk(env, message);
          } else {
            await markBackfillJobCompleted(env.DB, {
              alias: parsed.sync.alias,
              dependencyKind: "sync",
              processedCount: backfillJob.processedCount + scopedSourceRecordIds.length,
              reason: parsed.trigger.reason,
              workflowVersionId: parsed.workflowVersionId,
              workspaceId: message.workspaceId
            });
          }
        } else {
          await markBackfillJobCompleted(env.DB, {
            alias: parsed.sync.alias,
            dependencyKind: "sync",
            processedCount: sourceRows.length,
            reason: parsed.trigger.reason,
            workflowVersionId: parsed.workflowVersionId,
            workspaceId: message.workspaceId
          });
        }
      }
    } catch (error) {
      if (parsed.trigger.kind === "backfill" && backfillJob) {
        await markBackfillJobFailed(env.DB, {
          alias: parsed.sync.alias,
          dependencyKind: "sync",
          error,
          reason: parsed.trigger.reason,
          workflowVersionId: parsed.workflowVersionId,
          workspaceId: message.workspaceId
        });
      }
      throw error;
    }
    return;
  }

  let backfillJob: BackfillJobState | null = null;
  if (parsed.trigger.kind === "backfill") {
    backfillJob = await markBackfillJobRunning(env.DB, {
      alias: parsed.aggregate.alias,
      dependencyKind: "aggregate",
      reason: parsed.trigger.reason,
      workflowVersionId: parsed.workflowVersionId,
      workspaceId: message.workspaceId
    });
    if (backfillJob && isTerminalBackfillStatus(backfillJob.status)) {
      return;
    }
  }
  const registry = createAggregateOperationRegistry();
  const operation = registry.require(parsed.aggregate.operationId);
  const configDiagnostics = operation.validateConfig?.(parsed.aggregate.operationConfig) ?? [];
  if (configDiagnostics.length > 0) {
    throw new Error(
      `Invalid aggregate operation config for ${parsed.aggregate.alias}: ${configDiagnostics.join(", ")}`
    );
  }

  const targetRecordIdsWithSentinel =
    parsed.trigger.kind === "backfill" && backfillJob
      ? await loadActiveRecordIdChunk(env.DB, {
          afterRecordId: backfillJob.cursor.lastRecordId,
          limit: backfillJob.chunkSize + 1,
          tableId: parsed.aggregate.targetTableId,
          workspaceId: message.workspaceId
        })
      : await loadActiveRecordIds(env.DB, message.workspaceId, parsed.aggregate.targetTableId);
  const targetRecordIds =
    parsed.trigger.kind === "backfill" && backfillJob
      ? targetRecordIdsWithSentinel.slice(0, backfillJob.chunkSize)
      : targetRecordIdsWithSentinel;
  const hasMoreBackfillRecords =
    parsed.trigger.kind === "backfill" &&
    backfillJob !== null &&
    targetRecordIdsWithSentinel.length > backfillJob.chunkSize;

  try {
    const [sourceRows, currentValues] = await Promise.all([
      loadRelatedSourceRows(env.DB, message.workspaceId, parsed.aggregate),
      loadCurrentTargetFieldValues(env.DB, message.workspaceId, parsed.aggregate)
    ]);

    for (const targetRecordId of targetRecordIds) {
      const rowsForTarget = sourceRows.filter((row) => row.targetRecordId === targetRecordId);
      const nextValue = operation.evaluate({
        config: parsed.aggregate.operationConfig,
        rows: rowsForTarget
      });
      const currentValue = currentValues.get(targetRecordId) ?? null;

      if (JSON.stringify(currentValue) === JSON.stringify(nextValue)) {
        continue;
      }

      const identity = commandIdentityForTarget({
        aggregate: parsed.aggregate,
        targetRecordId,
        trigger: parsed.trigger,
        workflowId: parsed.workflowId,
        workflowVersionId: parsed.workflowVersionId
      });
      await dispatchCoordinatorOwnedCellSet(env, {
        ...applyWorkflowServiceIdentity(workflowServiceIdentity),
        commandId: identity.commandId,
        commandType: "cell.set",
        idempotencyKey: identity.idempotencyKey,
        payload: {
          fieldId: parsed.aggregate.targetFieldId,
          fieldType: "computed.readonly",
          recordId: targetRecordId,
          value: nextValue
        },
        scope: "table",
        tableId: parsed.aggregate.targetTableId,
        workspaceId: message.workspaceId
      });
    }

    if (parsed.trigger.kind === "backfill") {
      if (backfillJob) {
        if (hasMoreBackfillRecords && targetRecordIds.length > 0) {
          await markBackfillJobChunkProgress(env.DB, {
            alias: parsed.aggregate.alias,
            dependencyKind: "aggregate",
            lastRecordId: targetRecordIds[targetRecordIds.length - 1]!,
            processedCount: targetRecordIds.length,
            reason: parsed.trigger.reason,
            workflowVersionId: parsed.workflowVersionId,
            workspaceId: message.workspaceId
          });
          await enqueueNextBackfillChunk(env, message);
        } else {
          await markBackfillJobCompleted(env.DB, {
            alias: parsed.aggregate.alias,
            dependencyKind: "aggregate",
            processedCount: backfillJob.processedCount + targetRecordIds.length,
            reason: parsed.trigger.reason,
            workflowVersionId: parsed.workflowVersionId,
            workspaceId: message.workspaceId
          });
        }
      } else {
        await markBackfillJobCompleted(env.DB, {
          alias: parsed.aggregate.alias,
          dependencyKind: "aggregate",
          processedCount: targetRecordIds.length,
          reason: parsed.trigger.reason,
          workflowVersionId: parsed.workflowVersionId,
          workspaceId: message.workspaceId
        });
      }
    }
  } catch (error) {
    if (parsed.trigger.kind === "backfill" && backfillJob) {
      await markBackfillJobFailed(env.DB, {
        alias: parsed.aggregate.alias,
        dependencyKind: "aggregate",
        error,
        reason: parsed.trigger.reason,
        workflowVersionId: parsed.workflowVersionId,
        workspaceId: message.workspaceId
      });
    }
    throw error;
  }
}
