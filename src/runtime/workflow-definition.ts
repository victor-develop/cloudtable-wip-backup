import type { FieldTypeRegistry } from "../core/field-types/types";
import type { WorkflowAuthoringMetadata } from "../core/workflows/types";
import { readTableSchemaMetadata } from "./schema-metadata-read";

type PersistedWorkflowDefinition = {
  metadata?: {
    status?: "draft" | "published" | "paused";
  };
  trigger?: {
    match?: {
      tableId?: string;
    };
  };
};

type WorkflowDefinitionRow = {
  current_version?: number;
  published_at?: string | null;
  version?: number;
  workflow_id?: string;
  workflow_key?: string;
  workflow_name?: string;
  definition_json: string;
  workflow_version_id: string;
};

export type WorkflowDefinitionMetadata = {
  currentVersion: number;
  definition: Record<string, unknown>;
  effectiveVersion: number;
  publishedAt: string | null;
  referencedFieldIds: string[];
  status: "draft" | "published" | "paused";
  triggerTableId: string | null;
  workflow: WorkflowAuthoringMetadata;
  workflowId: string;
  workflowKey: string;
  workflowName: string;
  workflowVersionId: string;
  workspaceId: string;
};

export type WorkflowExecutionCandidate =
  | {
      ok: false;
      reason: "workflow_not_found" | "workflow_not_published" | "workflow_paused";
    }
  | {
      ok: true;
      triggerTableId: string | null;
      workflowId: string;
      workflowVersionId: string;
    };

export function workflowStatus(
  definition: PersistedWorkflowDefinition
): "draft" | "published" | "paused" {
  const status =
    definition.metadata && typeof definition.metadata.status === "string"
      ? definition.metadata.status
      : null;

  if (status === "draft" || status === "published" || status === "paused") {
    return status;
  }

  return "published";
}

function normalizeWorkflowDefinition(definition: unknown): Record<string, unknown> | null {
  if (!isRecord(definition)) {
    return null;
  }

  return isRecord(definition.definition) ? definition.definition : definition;
}

export function readWorkflowTriggerTableId(definition: unknown): string | null {
  const resolvedDefinition = normalizeWorkflowDefinition(definition);
  if (!resolvedDefinition) {
    return null;
  }

  const trigger = isRecord(resolvedDefinition.trigger) ? resolvedDefinition.trigger : null;
  const match = trigger && isRecord(trigger.match) ? trigger.match : null;
  return typeof match?.tableId === "string" && match.tableId.length > 0 ? match.tableId : null;
}

export function readWorkflowReferencedFieldIds(definition: unknown): string[] {
  const resolvedDefinition = normalizeWorkflowDefinition(definition);
  if (!resolvedDefinition) {
    return [];
  }

  const referencedFieldIds = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (key === "fieldId" && typeof value === "string" && value.length > 0) {
      referencedFieldIds.add(value);
      return;
    }

    if (key === "fieldIds" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) {
          referencedFieldIds.add(entry);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, childKey);
    }
  };

  visit(resolvedDefinition);
  return Array.from(referencedFieldIds).sort();
}

async function readLatestPublishedWorkflowRow(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<WorkflowDefinitionRow | null> {
  return db
    .prepare(
      `SELECT
         workflows.id AS workflow_id,
         workflows.workflow_key AS workflow_key,
         workflows.name AS workflow_name,
         workflows.current_version AS current_version,
         workflow_versions.version AS version,
         workflow_versions.id AS workflow_version_id,
         workflow_versions.definition_json,
         workflow_versions.published_at AS published_at
       FROM workflows
       INNER JOIN workflow_versions
         ON workflow_versions.workflow_id = workflows.id
        AND workflow_versions.workspace_id = workflows.workspace_id
       WHERE workflows.workspace_id = ?
         AND workflows.id = ?
         AND workflows.archived_at IS NULL
         AND workflow_versions.published_at IS NOT NULL
       ORDER BY workflow_versions.version DESC
       LIMIT 1`
    )
    .bind(workspaceId, workflowId)
    .first<WorkflowDefinitionRow>();
}

export async function readWorkflowDefinitionMetadata(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry | undefined,
  workspaceId: string,
  workflowId: string
): Promise<WorkflowDefinitionMetadata | null> {
  const row = await db
    .prepare(
      `SELECT
         workflows.id AS workflow_id,
         workflows.workflow_key AS workflow_key,
         workflows.name AS workflow_name,
         workflows.current_version AS current_version,
         workflow_versions.id AS workflow_version_id,
         workflow_versions.definition_json,
         workflow_versions.published_at AS published_at
       FROM workflows
       INNER JOIN workflow_versions
         ON workflow_versions.workflow_id = workflows.id
        AND workflow_versions.workspace_id = workflows.workspace_id
        AND workflow_versions.version = workflows.current_version
       WHERE workflows.workspace_id = ?
         AND workflows.id = ?
         AND workflows.archived_at IS NULL`
    )
    .bind(workspaceId, workflowId)
    .first<WorkflowDefinitionRow>();

  if (!row) {
    return null;
  }

  let parsedDefinition: unknown;
  try {
    parsedDefinition = JSON.parse(row.definition_json);
  } catch {
    return null;
  }

  const definition = normalizeWorkflowDefinition(parsedDefinition);
  if (!definition) {
    return null;
  }

  const triggerTableId = readWorkflowTriggerTableId(parsedDefinition);
  const tableMetadata =
    triggerTableId && fieldTypeRegistry
      ? await readTableSchemaMetadata(db, fieldTypeRegistry, {
          tableId: triggerTableId,
          workspaceId
        })
      : null;

  return {
    currentVersion: row.current_version ?? 0,
    definition,
    effectiveVersion: row.version ?? row.current_version ?? 0,
    publishedAt: row.published_at ?? null,
    referencedFieldIds: readWorkflowReferencedFieldIds(parsedDefinition),
    status: workflowStatus(
      isRecord(parsedDefinition) ? (parsedDefinition as PersistedWorkflowDefinition) : {}
    ),
    triggerTableId,
    workflow: tableMetadata?.workflow ?? { bindings: {} },
    workflowId: row.workflow_id ?? workflowId,
    workflowKey: row.workflow_key ?? "",
    workflowName: row.workflow_name ?? "",
    workflowVersionId: row.workflow_version_id,
    workspaceId
  };
}

export async function readWorkflowExecutionCandidate(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<WorkflowExecutionCandidate> {
  const row = await readLatestPublishedWorkflowRow(db, workspaceId, workflowId);

  if (!row) {
    return {
      ok: false,
      reason: "workflow_not_found"
    };
  }

  let definition: PersistedWorkflowDefinition;
  try {
    definition = JSON.parse(row.definition_json) as PersistedWorkflowDefinition;
  } catch {
    return {
      ok: false,
      reason: "workflow_not_found"
    };
  }

  const status = workflowStatus(definition);
  if (status === "draft") {
    return {
      ok: false,
      reason: "workflow_not_published"
    };
  }
  if (status === "paused") {
    return {
      ok: false,
      reason: "workflow_paused"
    };
  }

  return {
    ok: true,
    triggerTableId: readWorkflowTriggerTableId(definition),
    workflowId,
    workflowVersionId: row.workflow_version_id
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
