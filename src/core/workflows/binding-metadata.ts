import type { FieldTypeRegistry, JsonValue } from "../field-types/types";
import {
  listCanonicalWorkflowBindingAliases
} from "../ownership/row-owner";
import { serializeWorkflowOperatorManifest } from "./manifest";
import { createWorkflowOperatorRegistry } from "./operator-registry";
import type {
  WorkflowAuthoringMetadata,
  WorkflowConditionBindingMetadata,
  WorkflowConditionManifest,
  WorkflowOperatorRegistry
} from "./types";

export type WorkflowBindingMetadataField = {
  config: JsonValue;
  fieldId: string;
  fieldKey: string;
  fieldType: string;
};

type WorkflowBindingMetadataSource = {
  aliasOf?: string;
  binding: string;
  fieldTypeRegistry: FieldTypeRegistry;
  field: WorkflowBindingMetadataField;
  isCanonical?: boolean;
  workflowOperatorRegistry: WorkflowOperatorRegistry;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function buildBindingMetadata({
  aliasOf,
  binding,
  fieldTypeRegistry,
  field,
  isCanonical,
  workflowOperatorRegistry
}: WorkflowBindingMetadataSource): WorkflowConditionBindingMetadata {
  const definition = fieldTypeRegistry.require(field.fieldType);
  const supportedOperatorIds = definition.getSupportedConditionOperators({
    fieldConfig: field.config,
    fieldType: field.fieldType
  });
  const supportedOperators = supportedOperatorIds.map((operatorId) => {
    const operator = workflowOperatorRegistry.require(operatorId);
    if (operator.kind !== "condition") {
      throw new Error(
        `Workflow binding ${binding} references non-condition operator: ${operatorId}`
      );
    }

    return serializeWorkflowOperatorManifest(operator) as WorkflowConditionManifest;
  });
  const proposalHints = definition.getWorkflowProposalHints({
    aliasOf,
    binding,
    bindingKind: aliasOf ? "alias" : "field",
    fieldConfig: field.config,
    fieldType: field.fieldType,
    isCanonical
  });

  return {
    aliasOf,
    binding,
    fieldId: field.fieldId,
    fieldKey: field.fieldKey,
    fieldType: field.fieldType,
    isCanonical,
    proposalHints: [...proposalHints],
    supportedOperatorIds: [...supportedOperatorIds],
    supportedOperators,
    template: {
      fieldIdPath: `${binding}.fieldId`,
      fieldTypePath: `${binding}.fieldType`,
      valuePath: `${binding}.value`
    }
  };
}

export function buildWorkflowAuthoringMetadata(
  fieldTypeRegistry: FieldTypeRegistry,
  fields: readonly WorkflowBindingMetadataField[],
  workflowOperatorRegistry: WorkflowOperatorRegistry = createWorkflowOperatorRegistry()
): WorkflowAuthoringMetadata {
  const bindings: Record<string, WorkflowConditionBindingMetadata> = {};

  for (const alias of listCanonicalWorkflowBindingAliases(fields)) {
    bindings[alias.binding] = buildBindingMetadata({
      aliasOf: alias.aliasOf,
      binding: alias.binding,
      field: alias.field,
      fieldTypeRegistry,
      isCanonical: alias.isCanonical,
      workflowOperatorRegistry
    });
  }

  for (const field of fields) {
    bindings[`row.fields.${field.fieldKey}`] = buildBindingMetadata({
      binding: `row.fields.${field.fieldKey}`,
      field,
      fieldTypeRegistry,
      workflowOperatorRegistry
    });
  }

  return {
    bindings
  };
}

export function buildWorkflowAuthoringMetadataForFields<T>(
  fieldTypeRegistry: FieldTypeRegistry,
  fields: readonly T[],
  selectField: (field: T) => WorkflowBindingMetadataField,
  workflowOperatorRegistry: WorkflowOperatorRegistry = createWorkflowOperatorRegistry()
): WorkflowAuthoringMetadata {
  return buildWorkflowAuthoringMetadata(
    fieldTypeRegistry,
    fields.map((field) => selectField(field)),
    workflowOperatorRegistry
  );
}

function normalizeBindingMetadata(
  bindingName: string,
  value: unknown
): WorkflowConditionBindingMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const binding = asString(value.binding) ?? bindingName;
  const aliasOf = asString(value.aliasOf) ?? undefined;
  const fieldId = asString(value.fieldId);
  const fieldKey = asString(value.fieldKey);
  const fieldType = asString(value.fieldType);
  const isCanonical = value.isCanonical === true ? true : undefined;
  const template = isRecord(value.template) ? value.template : null;
  const fieldIdPath = asString(template?.fieldIdPath);
  const fieldTypePath = asString(template?.fieldTypePath);
  const valuePath = asString(template?.valuePath);

  if (!fieldId || !fieldKey || !fieldType || !fieldIdPath || !fieldTypePath || !valuePath) {
    return null;
  }

  const supportedOperatorIds = asStringArray(value.supportedOperatorIds);
  const supportedOperators = Array.isArray(value.supportedOperators)
    ? value.supportedOperators.filter(
        (entry): entry is WorkflowConditionManifest =>
          isRecord(entry) &&
          entry.kind === "condition" &&
          typeof entry.id === "string" &&
          typeof entry.version === "number"
      )
    : [];
  const proposalHints = Array.isArray(value.proposalHints)
    ? value.proposalHints.filter(
        (entry): entry is WorkflowConditionBindingMetadata["proposalHints"][number] =>
          isRecord(entry) &&
          typeof entry.operatorId === "string" &&
          Array.isArray(entry.matchPhrases) &&
          entry.matchPhrases.every((phrase) => typeof phrase === "string") &&
          (entry.draftInput === undefined || isRecord(entry.draftInput)) &&
          (entry.matchFieldPhrases === undefined ||
            (Array.isArray(entry.matchFieldPhrases) &&
              entry.matchFieldPhrases.every((phrase) => typeof phrase === "string")))
      )
      .map((entry) => ({
        draftInput: isRecord(entry.draftInput) ? (entry.draftInput as Record<string, JsonValue>) : undefined,
        matchFieldPhrases: entry.matchFieldPhrases,
        matchPhrases: entry.matchPhrases,
        operatorId: entry.operatorId
      }))
    : [];

  return {
    aliasOf,
    binding,
    fieldId,
    fieldKey,
    fieldType,
    isCanonical,
    proposalHints,
    supportedOperatorIds,
    supportedOperators,
    template: {
      fieldIdPath,
      fieldTypePath,
      valuePath
    }
  };
}

export function normalizeWorkflowAuthoringMetadata(value: unknown): WorkflowAuthoringMetadata {
  if (!isRecord(value)) {
    return { bindings: {} };
  }

  const workflow = isRecord(value.workflow) ? value.workflow : value;
  const bindings = isRecord(workflow.bindings) ? workflow.bindings : null;
  if (!bindings) {
    return { bindings: {} };
  }

  const normalizedBindings = Object.fromEntries(
    Object.entries(bindings)
      .map(([bindingName, metadata]) => [bindingName, normalizeBindingMetadata(bindingName, metadata)] as const)
      .filter((entry): entry is readonly [string, WorkflowConditionBindingMetadata] => entry[1] !== null)
  );

  return {
    bindings: normalizedBindings
  };
}
