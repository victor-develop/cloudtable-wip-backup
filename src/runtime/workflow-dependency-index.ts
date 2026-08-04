import type { JsonValue } from "../core/field-types/types";
import type {
  WorkflowAggregateDefinition,
  WorkflowDefinition,
  WorkflowLookupDefinition,
  WorkflowRelatedTableResolver
} from "../core/workflows/types";
import { workflowStatus } from "./workflow-definition";

export type PersistedWorkflowDefinition = WorkflowDefinition & {
  metadata?: WorkflowDefinition["metadata"] & {
    tableId?: string;
  };
};

export type RoutedAggregateDefinition = {
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
  resolver: WorkflowRelatedTableResolver;
  sourceRelationPath: string;
  sourceTableId: string;
  targetFieldId: string;
  targetTableId: string;
};

export type RoutedLookupDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  lookupSource: {
    kind: "related_record";
    resolverAlias: string;
    sourceFieldId: string;
  };
  resolver: Extract<WorkflowRelatedTableResolver, { strategy: "single_relation" }>;
  sourceRelationPath: string;
  sourceTableId: string;
  targetFieldId: string;
  valueFieldId: string;
};

export type RoutedSyncDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  resolver: WorkflowRelatedTableResolver;
  sourceFieldId: string;
  sourceTableId: string;
  targetFieldId: string;
  targetTableId: string;
};

export type WorkflowDependencyEntry =
  | {
      alias: string;
      definition: RoutedAggregateDefinition;
      dependencyFieldIds: string[];
      kind: "aggregate";
      sourceTableId: string;
      targetTableId: string;
      triggerTableId: string | null;
    }
  | {
      alias: string;
      definition: RoutedLookupDefinition;
      dependencyFieldIds: string[];
      kind: "lookup";
      sourceTableId: string;
      targetTableId: string;
      triggerTableId: string | null;
    }
  | {
      alias: string;
      definition: RoutedSyncDefinition;
      dependencyFieldIds: string[];
      kind: "sync";
      sourceTableId: string;
      targetTableId: string;
      triggerTableId: string | null;
    }
  | {
      alias: string;
      definition: WorkflowDefinition["trigger"];
      dependencyFieldIds: string[];
      kind: "trigger";
      sourceTableId: string | null;
      targetTableId: string | null;
      triggerTableId: string | null;
    }
  | {
      alias: string;
      definition: WorkflowRelatedTableResolver;
      dependencyFieldIds: string[];
      kind: "resolver";
      sourceTableId: string | null;
      targetTableId: string;
      triggerTableId: string | null;
    };

type WorkflowVersionRow = {
  definition_json: string;
  workflow_id: string;
  workflow_version_id: string;
  workspace_id: string;
};

type WorkflowDependencyRow = {
  alias: string;
  definition_json: string;
  dependency_field_ids_json: string;
  dependency_kind: "aggregate" | "lookup" | "sync" | "trigger" | "resolver";
  source_table_id: string | null;
  target_table_id: string | null;
  trigger_table_id: string | null;
  workflow_id: string;
  workflow_version_id: string;
};

type ReactiveDependencyRoute =
  | {
      aggregate: RoutedAggregateDefinition;
      workflowId: string;
      workflowVersionId: string;
    }
  | {
      lookup: RoutedLookupDefinition;
      workflowId: string;
      workflowVersionId: string;
    }
  | {
      sync: RoutedSyncDefinition;
      workflowId: string;
      workflowVersionId: string;
    };

export function readWorkflowRelatedTableResolvers(
  definition: PersistedWorkflowDefinition
): WorkflowRelatedTableResolver[] {
  const resolvers = definition.metadata?.relatedTableResolvers;
  return Array.isArray(resolvers) ? [...resolvers] : [];
}

export function readWorkflowAggregateDefinitions(
  definition: PersistedWorkflowDefinition
): WorkflowAggregateDefinition[] {
  const aggregateDefinitions = definition.metadata?.aggregateDefinitions;
  return Array.isArray(aggregateDefinitions) ? [...aggregateDefinitions] : [];
}

export function readWorkflowLookupDefinitions(
  definition: PersistedWorkflowDefinition
): WorkflowLookupDefinition[] {
  const lookupDefinitions = definition.metadata?.lookupDefinitions;
  return Array.isArray(lookupDefinitions) ? [...lookupDefinitions] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workflowSyncAlias(input: {
  resolverAlias: string;
  sourceFieldId: string;
  targetFieldId: string;
}): string {
  return `${input.resolverAlias}:${input.sourceFieldId}:${input.targetFieldId}`;
}

export function deriveAggregateDefinitions(
  definition: PersistedWorkflowDefinition
): RoutedAggregateDefinition[] {
  const sourceTableId =
    typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null;
  if (!sourceTableId) {
    return [];
  }

  const resolvers = new Map(
    readWorkflowRelatedTableResolvers(definition).map((resolver) => [resolver.alias, resolver])
  );

  return readWorkflowAggregateDefinitions(definition)
    .map((aggregate) => {
      const resolver = resolvers.get(aggregate.groupingSource.resolverAlias);
      if (!resolver) {
        return null;
      }

      return {
        alias: aggregate.alias,
        dependencyFieldIds: Array.from(
          new Set([
            resolver.sourceFieldId,
            ...(aggregate.operand ? [aggregate.operand.fieldId] : []),
            ...(aggregate.dependencyFieldIds ?? [])
          ])
        ),
        groupingSource: {
          kind: "related_record" as const,
          resolverAlias: aggregate.groupingSource.resolverAlias,
          sourceFieldId: resolver.sourceFieldId
        },
        ...(aggregate.operand ? { operand: aggregate.operand } : {}),
        operationConfig:
          aggregate.operationConfig && isRecord(aggregate.operationConfig)
            ? aggregate.operationConfig
            : {},
        operationId: aggregate.operationId,
        resolver,
        sourceRelationPath: aggregate.sourceRelationPath,
        sourceTableId,
        targetFieldId: aggregate.targetFieldId,
        targetTableId: resolver.targetTableId
      };
    })
    .filter((aggregate): aggregate is RoutedAggregateDefinition => aggregate !== null);
}

export function deriveLookupDefinitions(
  definition: PersistedWorkflowDefinition
): RoutedLookupDefinition[] {
  const sourceTableId =
    typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null;
  if (!sourceTableId) {
    return [];
  }

  const resolvers = new Map(
    readWorkflowRelatedTableResolvers(definition).map((resolver) => [resolver.alias, resolver])
  );

  return readWorkflowLookupDefinitions(definition)
    .map((lookup) => {
      const resolver = resolvers.get(lookup.lookupSource.resolverAlias);
      if (!resolver || resolver.strategy !== "single_relation") {
        return null;
      }

      return {
        alias: lookup.alias,
        dependencyFieldIds: Array.from(
          new Set([resolver.sourceFieldId, ...(lookup.dependencyFieldIds ?? [])])
        ),
        lookupSource: {
          kind: "related_record" as const,
          resolverAlias: lookup.lookupSource.resolverAlias,
          sourceFieldId: resolver.sourceFieldId
        },
        resolver,
        sourceRelationPath: lookup.sourceRelationPath,
        sourceTableId,
        targetFieldId: lookup.targetFieldId,
        valueFieldId: lookup.valueFieldId
      };
    })
    .filter((lookup): lookup is RoutedLookupDefinition => lookup !== null);
}

export function deriveSyncDefinitions(
  definition: PersistedWorkflowDefinition
): RoutedSyncDefinition[] {
  const sourceTableId =
    typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null;
  if (!sourceTableId) {
    return [];
  }

  const resolvers = new Map(
    readWorkflowRelatedTableResolvers(definition).map((resolver) => [resolver.alias, resolver])
  );

  return definition.actions
    .map((action) => {
      if (action.operatorId !== "sync_related_field") {
        return null;
      }

      const input = isRecord(action.input) ? action.input : null;
      const resolverAlias =
        input && typeof input.resolverAlias === "string" ? input.resolverAlias : null;
      const sourceFieldId =
        input && typeof input.sourceFieldId === "string" ? input.sourceFieldId : null;
      const targetFieldId =
        input && typeof input.targetFieldId === "string" ? input.targetFieldId : null;

      if (!resolverAlias || !sourceFieldId || !targetFieldId) {
        return null;
      }

      const resolver = resolvers.get(resolverAlias);
      if (!resolver) {
        return null;
      }

      return {
        alias: workflowSyncAlias({
          resolverAlias,
          sourceFieldId,
          targetFieldId
        }),
        dependencyFieldIds: Array.from(new Set([resolver.sourceFieldId, sourceFieldId])),
        resolver,
        sourceFieldId,
        sourceTableId,
        targetFieldId,
        targetTableId: resolver.targetTableId
      };
    })
    .filter((sync): sync is RoutedSyncDefinition => sync !== null);
}

function triggerFieldIds(definition: PersistedWorkflowDefinition): string[] {
  const matcher = definition.trigger.match;
  if (Array.isArray(matcher?.fieldIds)) {
    return matcher.fieldIds.filter(
      (fieldId): fieldId is string => typeof fieldId === "string" && fieldId.length > 0
    );
  }
  return typeof matcher?.fieldId === "string" && matcher.fieldId.length > 0
    ? [matcher.fieldId]
    : [];
}

export function deriveWorkflowDependencyEntries(
  definition: PersistedWorkflowDefinition
): WorkflowDependencyEntry[] {
  const triggerTableId =
    typeof definition.trigger.match?.tableId === "string" ? definition.trigger.match.tableId : null;
  const entries: WorkflowDependencyEntry[] = [
    {
      alias: definition.trigger.operatorId,
      definition: definition.trigger,
      dependencyFieldIds: triggerFieldIds(definition),
      kind: "trigger",
      sourceTableId: triggerTableId,
      targetTableId: null,
      triggerTableId
    }
  ];

  for (const resolver of readWorkflowRelatedTableResolvers(definition)) {
    entries.push({
      alias: resolver.alias,
      definition: resolver,
      dependencyFieldIds: [resolver.sourceFieldId],
      kind: "resolver",
      sourceTableId: typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null,
      targetTableId: resolver.targetTableId,
      triggerTableId
    });
  }

  for (const aggregate of deriveAggregateDefinitions(definition)) {
    entries.push({
      alias: aggregate.alias,
      definition: aggregate,
      dependencyFieldIds: aggregate.dependencyFieldIds,
      kind: "aggregate",
      sourceTableId: aggregate.sourceTableId,
      targetTableId: aggregate.targetTableId,
      triggerTableId
    });
  }

  for (const lookup of deriveLookupDefinitions(definition)) {
    entries.push({
      alias: lookup.alias,
      definition: lookup,
      dependencyFieldIds: lookup.dependencyFieldIds,
      kind: "lookup",
      sourceTableId: lookup.sourceTableId,
      targetTableId: lookup.resolver.targetTableId,
      triggerTableId
    });
  }

  for (const sync of deriveSyncDefinitions(definition)) {
    entries.push({
      alias: sync.alias,
      definition: sync,
      dependencyFieldIds: sync.dependencyFieldIds,
      kind: "sync",
      sourceTableId: sync.sourceTableId,
      targetTableId: sync.targetTableId,
      triggerTableId
    });
  }

  return entries;
}

export function workflowDependencyIndexStatements(
  db: D1Database,
  input: {
    definition: PersistedWorkflowDefinition;
    eventId?: string | null;
    now: string;
    workflowId: string;
    workflowVersionId: string;
    workspaceId: string;
  }
): D1PreparedStatement[] {
  const status = workflowStatus(input.definition);
  const entries = deriveWorkflowDependencyEntries(input.definition);
  const statements = [
    db
      .prepare(`DELETE FROM workflow_dependency_index WHERE workspace_id = ? AND workflow_version_id = ?`)
      .bind(input.workspaceId, input.workflowVersionId)
  ];

  for (const entry of entries) {
    statements.push(
      db
        .prepare(
          `INSERT INTO workflow_dependency_index (
             id,
             workspace_id,
             workflow_id,
             workflow_version_id,
             dependency_kind,
             alias,
             source_table_id,
             target_table_id,
             trigger_table_id,
             dependency_field_ids_json,
             definition_json,
             status,
             updated_at,
             last_event_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          [
            "wdep",
            input.workspaceId,
            input.workflowVersionId,
            entry.kind,
            entry.alias
          ].join(":"),
          input.workspaceId,
          input.workflowId,
          input.workflowVersionId,
          entry.kind,
          entry.alias,
          entry.sourceTableId,
          entry.targetTableId,
          entry.triggerTableId,
          JSON.stringify(entry.dependencyFieldIds),
          JSON.stringify(entry.definition),
          status,
          input.now,
          input.eventId ?? null
        )
    );
  }

  return statements;
}

export async function rebuildWorkflowDependencyIndexForVersion(
  db: D1Database,
  input: {
    definition: PersistedWorkflowDefinition;
    eventId?: string | null;
    now?: string;
    workflowId: string;
    workflowVersionId: string;
    workspaceId: string;
  }
): Promise<void> {
  await db.batch(
    workflowDependencyIndexStatements(db, {
      ...input,
      now: input.now ?? new Date().toISOString()
    })
  );
}

export async function ensureWorkflowDependencyIndexForWorkspace(
  db: D1Database,
  workspaceId: string
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM workflow_dependency_index
         WHERE workspace_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT workflow_versions.workspace_id,
                      workflow_versions.workflow_id,
                      MAX(workflow_versions.version) AS version
               FROM workflow_versions
               WHERE workflow_versions.workspace_id = ?
                 AND workflow_versions.published_at IS NOT NULL
               GROUP BY workflow_versions.workspace_id, workflow_versions.workflow_id
             ) latest
             INNER JOIN workflow_versions published
               ON published.workspace_id = latest.workspace_id
              AND published.workflow_id = latest.workflow_id
              AND published.version = latest.version
             INNER JOIN workflows
               ON workflows.id = published.workflow_id
              AND workflows.workspace_id = published.workspace_id
             WHERE workflows.archived_at IS NULL
               AND published.workspace_id = workflow_dependency_index.workspace_id
               AND published.workflow_id = workflow_dependency_index.workflow_id
               AND published.id = workflow_dependency_index.workflow_version_id
           )`
      )
      .bind(workspaceId, workspaceId)
  ]);

  const rows = await db
    .prepare(
      `SELECT
         published.workspace_id AS workspace_id,
         published.id AS workflow_version_id,
         published.workflow_id AS workflow_id,
         published.definition_json AS definition_json
       FROM (
         SELECT workflow_versions.workspace_id,
                workflow_versions.workflow_id,
                MAX(workflow_versions.version) AS version
         FROM workflow_versions
         WHERE workflow_versions.workspace_id = ?
           AND workflow_versions.published_at IS NOT NULL
         GROUP BY workflow_versions.workspace_id, workflow_versions.workflow_id
       ) latest
       INNER JOIN workflow_versions published
         ON published.workspace_id = latest.workspace_id
        AND published.workflow_id = latest.workflow_id
        AND published.version = latest.version
       INNER JOIN workflows
         ON workflows.id = published.workflow_id
        AND workflows.workspace_id = published.workspace_id
       WHERE workflows.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM workflow_dependency_index
           WHERE workflow_dependency_index.workspace_id = published.workspace_id
             AND workflow_dependency_index.workflow_version_id = published.id
           LIMIT 1
         )`
    )
    .bind(workspaceId)
    .all<WorkflowVersionRow>();

  for (const row of rows.results ?? []) {
    await rebuildWorkflowDependencyIndexForVersion(db, {
      definition: JSON.parse(row.definition_json) as PersistedWorkflowDefinition,
      workflowId: row.workflow_id,
      workflowVersionId: row.workflow_version_id,
      workspaceId: row.workspace_id
    });
  }
}

export async function ensureWorkflowDependencyIndexForWorkflow(
  db: D1Database,
  input: {
    workflowId: string;
    workspaceId: string;
  }
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM workflow_dependency_index
         WHERE workspace_id = ?
           AND workflow_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT workflow_versions.workspace_id,
                      workflow_versions.workflow_id,
                      MAX(workflow_versions.version) AS version
               FROM workflow_versions
               WHERE workflow_versions.workspace_id = ?
                 AND workflow_versions.workflow_id = ?
                 AND workflow_versions.published_at IS NOT NULL
               GROUP BY workflow_versions.workspace_id, workflow_versions.workflow_id
             ) latest
             INNER JOIN workflow_versions published
               ON published.workspace_id = latest.workspace_id
              AND published.workflow_id = latest.workflow_id
              AND published.version = latest.version
             INNER JOIN workflows
               ON workflows.id = published.workflow_id
              AND workflows.workspace_id = published.workspace_id
             WHERE published.workspace_id = workflow_dependency_index.workspace_id
               AND published.workflow_id = workflow_dependency_index.workflow_id
               AND published.id = workflow_dependency_index.workflow_version_id
               AND workflows.archived_at IS NULL
           )`
      )
      .bind(input.workspaceId, input.workflowId, input.workspaceId, input.workflowId)
  ]);

  const row = await db
    .prepare(
      `SELECT
         published.workspace_id AS workspace_id,
         published.id AS workflow_version_id,
         published.workflow_id AS workflow_id,
         published.definition_json AS definition_json
       FROM (
         SELECT workflow_versions.workspace_id,
                workflow_versions.workflow_id,
                MAX(workflow_versions.version) AS version
         FROM workflow_versions
         WHERE workflow_versions.workspace_id = ?
           AND workflow_versions.workflow_id = ?
           AND workflow_versions.published_at IS NOT NULL
         GROUP BY workflow_versions.workspace_id, workflow_versions.workflow_id
       ) latest
       INNER JOIN workflow_versions published
         ON published.workspace_id = latest.workspace_id
        AND published.workflow_id = latest.workflow_id
        AND published.version = latest.version
       INNER JOIN workflows
         ON workflows.id = published.workflow_id
        AND workflows.workspace_id = published.workspace_id
       WHERE workflows.archived_at IS NULL`
    )
    .bind(input.workspaceId, input.workflowId)
    .first<WorkflowVersionRow>();

  if (!row) {
    return;
  }

  await rebuildWorkflowDependencyIndexForVersion(db, {
    definition: JSON.parse(row.definition_json) as PersistedWorkflowDefinition,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    workspaceId: row.workspace_id
  });
}

function readDependencyFieldIds(row: WorkflowDependencyRow): string[] {
  try {
    const parsed = JSON.parse(row.dependency_field_ids_json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((fieldId): fieldId is string => typeof fieldId === "string")
      : [];
  } catch {
    return [];
  }
}

export async function readReactiveDependenciesForSourceEvent(
  db: D1Database,
  input: {
    changedFieldIds: string[];
    sourceTableId: string;
    workspaceId: string;
  }
): Promise<
  ReactiveDependencyRoute[]
> {
  const rows = await db
    .prepare(
      `SELECT
         workflow_id,
         workflow_version_id,
         dependency_kind,
         alias,
         source_table_id,
         target_table_id,
         trigger_table_id,
         dependency_field_ids_json,
         definition_json
       FROM workflow_dependency_index
       WHERE workspace_id = ?
         AND (source_table_id = ? OR target_table_id = ?)
         AND status = 'published'
         AND dependency_kind IN ('aggregate', 'lookup', 'sync')
       ORDER BY workflow_id ASC, dependency_kind ASC, alias ASC`
    )
    .bind(input.workspaceId, input.sourceTableId, input.sourceTableId)
    .all<WorkflowDependencyRow>();

  return (rows.results ?? []).flatMap((row): ReactiveDependencyRoute[] => {
    const dependencyFieldIds = readDependencyFieldIds(row);
    const definition = JSON.parse(row.definition_json) as unknown;
    if (row.dependency_kind === "aggregate") {
      const aggregate = definition as RoutedAggregateDefinition;
      const targetMatchFieldIds =
        aggregate.resolver.strategy === "value_match" ? [aggregate.resolver.targetFieldId] : [];
      const eventFieldIds =
        row.source_table_id === input.sourceTableId ? dependencyFieldIds : targetMatchFieldIds;
      if (eventFieldIds.length === 0) {
        return [];
      }
      if (
        input.changedFieldIds.length > 0 &&
        !eventFieldIds.some((fieldId) => input.changedFieldIds.includes(fieldId))
      ) {
        return [];
      }

      return [
        {
          aggregate,
          workflowId: row.workflow_id,
          workflowVersionId: row.workflow_version_id
        }
      ];
    }
    if (row.dependency_kind === "lookup") {
      const lookup = definition as RoutedLookupDefinition;
      const eventFieldIds =
        row.source_table_id === input.sourceTableId ? dependencyFieldIds : [lookup.valueFieldId];
      if (eventFieldIds.length === 0) {
        return [];
      }
      if (
        input.changedFieldIds.length > 0 &&
        !eventFieldIds.some((fieldId) => input.changedFieldIds.includes(fieldId))
      ) {
        return [];
      }

      return [
        {
          lookup,
          workflowId: row.workflow_id,
          workflowVersionId: row.workflow_version_id
        }
      ];
    }
    if (row.dependency_kind === "sync") {
      const sync = definition as RoutedSyncDefinition;
      const targetMatchFieldIds =
        sync.resolver.strategy === "value_match" ? [sync.resolver.targetFieldId] : [];
      const eventFieldIds =
        row.source_table_id === input.sourceTableId ? dependencyFieldIds : targetMatchFieldIds;
      if (eventFieldIds.length === 0) {
        return [];
      }
      if (
        input.changedFieldIds.length > 0 &&
        !eventFieldIds.some((fieldId) => input.changedFieldIds.includes(fieldId))
      ) {
        return [];
      }

      return [
        {
          sync,
          workflowId: row.workflow_id,
          workflowVersionId: row.workflow_version_id
        }
      ];
    }

    return [];
  });
}
