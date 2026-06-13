import { createCommandBus } from "../../../../src/core/commands/command-bus";
import { CommandCommitError } from "../../../../src/core/commands/errors";
import type { IdempotencyReceipt } from "../../../../src/core/commands/types";
import { createEventLedger } from "../../../../src/core/events/event-ledger";
import type { EventLedger, EventLedgerCommit } from "../../../../src/core/events/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import type { JsonValue } from "../../../../src/core/field-types/types";
import type { PermissionEngine } from "../../../../src/core/permissions/types";
import {
  buildWorkflowAuthoringMetadataForFields,
  normalizeWorkflowAuthoringMetadata
} from "../../../../src/core/workflows/binding-metadata";
import { validateWorkflowConditionBindings } from "../../../../src/core/workflows/authoring";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import type {
  WorkflowAuthoringMetadata,
  WorkflowConditionBindingMetadata,
  WorkflowDefinition
} from "../../../../src/core/workflows/types";
import type { CommandFixture } from "../fixtures/command-fixture";
import { InMemoryEventLedger } from "../runtime/in-memory-event-ledger";
import {
  insertField,
  insertRecord,
  seedAppAndTable,
  seedWorkspace,
  SqliteD1Database
} from "../runtime/sqlite-d1";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

class MetadataBackedEventLedger implements EventLedger {
  constructor(
    private readonly ledger: EventLedger,
    private readonly workflowAuthoringMetadata: WorkflowAuthoringMetadata
  ) {}

  now(): Promise<string> {
    return this.ledger.now();
  }

  findReceipt(scopeKey: string, idempotencyKey: string): Promise<IdempotencyReceipt | null> {
    return this.ledger.findReceipt(scopeKey, idempotencyKey);
  }

  async commitAcceptedCommand(commit: EventLedgerCommit) {
    if (
      (commit.command.commandType === "workflow.create" ||
        commit.command.commandType === "workflow.update") &&
      isWorkflowDefinition(commit.command.payload.definition)
    ) {
      const diagnostics = validateWorkflowConditionBindings(
        commit.command.payload.definition,
        this.workflowAuthoringMetadata
      );
      if (diagnostics.length > 0) {
        throw new CommandCommitError(
          diagnostics[0] ?? "workflow_condition_binding_invalid"
        );
      }
    }

    return this.ledger.commitAcceptedCommand(commit);
  }
}

export async function executeCommandFixture(
  fixture: CommandFixture
) {
  const commandBus = createCommandBus({
    eventLedger: createFixtureEventLedger(fixture),
    fieldTypeRegistry,
    permissionEngine: createPermissionEngine(
      fixture.seedState.permission ?? { allowed: true, reasons: [] }
    ),
    workflowOperatorRegistry,
    idFactory(prefix) {
      return `${prefix}_0001`;
    },
    now() {
      return fixture.meta.logicalStartTime;
    }
  });

  return commandBus.execute(fixture.command);
}

export function createFixtureEventLedger(fixture: CommandFixture): EventLedger {
  const workflowAuthoringMetadata = hydrateWorkflowAuthoringMetadata(fixture);

  if (fixture.seedState.persistence) {
    const baseLedger = createPersistenceBackedEventLedger(fixture);
    return workflowAuthoringMetadata
      ? new MetadataBackedEventLedger(baseLedger, workflowAuthoringMetadata)
      : baseLedger;
  }

  const baseLedger = new InMemoryEventLedger(
    fixture.meta.logicalStartTime,
    (fixture.seedState.receipts ?? []) as unknown as IdempotencyReceipt[]
  );

  return workflowAuthoringMetadata
    ? new MetadataBackedEventLedger(baseLedger, workflowAuthoringMetadata)
    : baseLedger;
}

export function toExpectedCommandResult(fixture: CommandFixture) {
  if (
    fixture.seedState.workflowAuthoringMetadata &&
    !fixture.seedState.persistence &&
    !fixture.expected.accepted &&
    fixture.expected.diagnostics.every((diagnostic) =>
      diagnostic.startsWith("workflow_condition_binding_")
    )
  ) {
    return {
      ...fixture.expected,
      permission: fixture.seedState.permission ?? {
        allowed: true,
        reasons: []
      }
    };
  }

  return fixture.expected;
}

function createPermissionEngine(permission: {
  allowed: boolean;
  reasons: string[];
}): PermissionEngine {
  return {
    describeField() {
      return {
        readRedaction: "none",
        allowsMutation: true,
        allowsWorkflowTrigger: true,
        supportsValueVisibilityRules: false
      };
    },
    evaluateFieldAccess(field) {
      return {
        allowed: true,
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        readState: "visible",
        reasons: [],
        writeAllowed: true
      };
    },
    explainFieldAccess(field, surfaces = ["direct-record-read"]) {
      return {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        surfaces: surfaces.map((surface) => ({
          allowed: true,
          message: "Allowed.",
          readState: "visible",
          reasonMessages: [],
          reasons: [],
          surface,
          writeAllowed: true
        }))
      };
    },
    evaluateCommand() {
      return permission;
    },
    projectFields() {
      return {
        diagnostics: [],
        fields: {},
        hiddenFieldIds: [],
        redactedFieldIds: [],
        states: {}
      };
    },
    filterAgentTools(tools) {
      return tools.map((tool) => ({
        allowed: true,
        hiddenFieldIds: [],
        reason: null,
        toolId: tool.id,
        visibleFieldIds: []
      }));
    },
    resolveAgentToolFieldVisibility() {
      return {
        hiddenFieldIds: [],
        visibleFieldIds: [],
        writableFieldIds: []
      };
    },
    listSurfaces() {
      return [];
    }
  };
}

function createPersistenceBackedEventLedger(fixture: CommandFixture) {
  const db = new SqliteD1Database();
  seedWorkspace(db, fixture.command.workspaceId);
  seedAppAndTable(db, {
    appId: fixture.seedState.persistence?.appId,
    tableId: fixture.command.tableId,
    workspaceId: fixture.command.workspaceId
  });

  for (const field of fixture.seedState.persistence?.fields ?? []) {
    insertField(db, {
      ...field,
      tableId: fixture.command.tableId as string,
      workspaceId: fixture.command.workspaceId
    });
  }

  for (const record of fixture.seedState.persistence?.records ?? []) {
    insertRecord(db, {
      ...record,
      tableId: fixture.command.tableId as string,
      workspaceId: fixture.command.workspaceId
    });
  }

  return createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
}

function mergeBindingMetadata(
  derived: WorkflowConditionBindingMetadata,
  explicit: WorkflowConditionBindingMetadata
): WorkflowConditionBindingMetadata {
  return {
    ...derived,
    ...explicit,
    proposalHints:
      explicit.proposalHints.length > 0 ? explicit.proposalHints : derived.proposalHints,
    supportedOperatorIds:
      explicit.supportedOperatorIds.length > 0
        ? explicit.supportedOperatorIds
        : derived.supportedOperatorIds,
    supportedOperators:
      explicit.supportedOperators.length > 0
        ? explicit.supportedOperators
        : derived.supportedOperators,
    template: {
      ...derived.template,
      ...explicit.template
    }
  };
}

export function hydrateWorkflowAuthoringMetadata(
  fixture: Pick<CommandFixture, "seedState">
): WorkflowAuthoringMetadata | null {
  const explicitMetadata = fixture.seedState.workflowAuthoringMetadata
    ? normalizeWorkflowAuthoringMetadata(fixture.seedState.workflowAuthoringMetadata)
    : null;
  const persistedFields = fixture.seedState.persistence?.fields ?? [];
  const derivedMetadata =
    persistedFields.length > 0
      ? buildWorkflowAuthoringMetadataForFields(fieldTypeRegistry, persistedFields, (field) => ({
          config: (field.config ?? {}) as JsonValue,
          fieldId: field.fieldId,
          fieldKey: field.fieldKey,
          fieldType: field.fieldType
        }))
      : null;

  if (!explicitMetadata && !derivedMetadata) {
    return null;
  }

  if (!explicitMetadata) {
    return derivedMetadata;
  }

  if (!derivedMetadata) {
    return explicitMetadata;
  }

  const bindingNames = new Set([
    ...Object.keys(derivedMetadata.bindings),
    ...Object.keys(explicitMetadata.bindings)
  ]);
  const bindings: Record<string, WorkflowConditionBindingMetadata> = {};

  for (const bindingName of bindingNames) {
    const derivedBinding = derivedMetadata.bindings[bindingName];
    const explicitBinding = explicitMetadata.bindings[bindingName];

    if (derivedBinding && explicitBinding) {
      bindings[bindingName] = mergeBindingMetadata(derivedBinding, explicitBinding);
      continue;
    }

    if (derivedBinding) {
      bindings[bindingName] = derivedBinding;
      continue;
    }

    if (explicitBinding) {
      bindings[bindingName] = explicitBinding;
    }
  }

  return { bindings };
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.actions) &&
    Array.isArray(candidate.conditions) &&
    typeof candidate.trigger === "object" &&
    candidate.trigger !== null &&
    !Array.isArray(candidate.trigger) &&
    typeof candidate.workflowId === "string"
  );
}
