import type {
  WorkflowAuthoringMetadata,
  WorkflowConditionBindingMetadata,
  WorkflowConditionBinding,
  WorkflowDefinition
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTemplatePath(value: unknown): string | null {
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0) {
    return null;
  }

  return value.path;
}

function collectTemplatePaths(value: unknown, paths: string[]): void {
  const templatePath = readTemplatePath(value);
  if (templatePath) {
    paths.push(templatePath);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTemplatePaths(entry, paths);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const entry of Object.values(value)) {
    collectTemplatePaths(entry, paths);
  }
}

function validateCanonicalBindingValue(
  index: number,
  bindingName: string,
  metadataKey: "fieldId" | "fieldType",
  metadata: WorkflowConditionBindingMetadata,
  value: unknown
): string[] {
  if (value === undefined) {
    return [];
  }

  const expectedLiteral = metadata[metadataKey];
  const expectedTemplate =
    metadataKey === "fieldId" ? metadata.template.fieldIdPath : metadata.template.fieldTypePath;
  if (value === expectedLiteral || readTemplatePath(value) === expectedTemplate) {
    return [];
  }

  return [
    `workflow_condition_binding_${metadataKey === "fieldId" ? "field_id" : "field_type"}_mismatch:${index}:${bindingName}`
  ];
}

function findReferencedBindingNames(
  condition: WorkflowConditionBinding,
  authoringMetadata: WorkflowAuthoringMetadata
): string[] {
  const paths: string[] = [];
  collectTemplatePaths(condition.input, paths);

  const referencedBindings = new Set<string>();
  for (const path of paths) {
    for (const [bindingName, metadata] of Object.entries(authoringMetadata.bindings)) {
      if (
        path === bindingName ||
        path === metadata.template.fieldIdPath ||
        path === metadata.template.fieldTypePath ||
        path === metadata.template.valuePath ||
        path.startsWith(`${bindingName}.`)
      ) {
        referencedBindings.add(bindingName);
      }
    }

    for (const suffix of [".fieldId", ".fieldType", ".value"]) {
      if (path.endsWith(suffix)) {
        referencedBindings.add(path.slice(0, -suffix.length));
      }
    }
  }

  return Array.from(referencedBindings).sort();
}

function validateConditionBinding(
  index: number,
  condition: WorkflowConditionBinding,
  bindingName: string,
  metadata: WorkflowConditionBindingMetadata
): string[] {
  const diagnostics: string[] = [];
  if (!metadata.supportedOperatorIds.includes(condition.operatorId)) {
    diagnostics.push(
      `workflow_condition_binding_operator_unsupported:${index}:${bindingName}:${condition.operatorId}`
    );
  }

  if (isRecord(condition.input)) {
    diagnostics.push(
      ...validateCanonicalBindingValue(
        index,
        bindingName,
        "fieldId",
        metadata,
        condition.input.fieldId
      ),
      ...validateCanonicalBindingValue(
        index,
        bindingName,
        "fieldType",
        metadata,
        condition.input.fieldType
      )
    );
  }

  return diagnostics;
}

export function validateWorkflowConditionBindings(
  definition: WorkflowDefinition,
  authoringMetadata: WorkflowAuthoringMetadata
): string[] {
  const diagnostics: string[] = [];

  for (const [index, condition] of definition.conditions.entries()) {
    const referencedBindings = findReferencedBindingNames(condition, authoringMetadata);
    for (const bindingName of referencedBindings) {
      const metadata = authoringMetadata.bindings[bindingName];
      if (!metadata) {
        diagnostics.push(`workflow_condition_binding_missing:${index}:${bindingName}`);
        continue;
      }

      diagnostics.push(...validateConditionBinding(index, condition, bindingName, metadata));
    }
  }

  return diagnostics;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function bindingSearchTerms(metadata: WorkflowConditionBindingMetadata): string[] {
  return Array.from(
    new Set(
      [metadata.binding, metadata.fieldKey, metadata.fieldType]
        .flatMap((value) => value.split(/[^a-zA-Z0-9]+/))
        .map(normalizeText)
        .filter((value) => value.length > 0)
    )
  );
}

function buildFieldPhraseVariants(metadata: WorkflowConditionBindingMetadata): string[] {
  const normalizedFieldKey = metadata.fieldKey.replace(/[^a-zA-Z0-9]+/g, " ").trim();

  return Array.from(
    new Set([
      metadata.fieldKey,
      normalizedFieldKey,
      ...metadata.fieldKey.split(/[^a-zA-Z0-9]+/),
      ...bindingSearchTerms(metadata)
    ])
  ).filter((value) => value.length > 0);
}

function mentionsBinding(
  bindingName: string,
  metadata: WorkflowConditionBindingMetadata,
  businessRule: string,
  fieldIds: readonly string[]
): boolean {
  if (fieldIds.includes(metadata.fieldId)) {
    return true;
  }

  const normalizedRule = normalizeText(businessRule);
  if (normalizedRule.length === 0) {
    return false;
  }

  if (normalizedRule.includes(normalizeText(bindingName))) {
    return true;
  }

  return bindingSearchTerms(metadata).some((term) => normalizedRule.includes(term));
}

function buildProposalHintPhrases(
  metadata: WorkflowConditionBindingMetadata,
  hint: WorkflowConditionBindingMetadata["proposalHints"][number]
): string[] {
  const fieldPhrases = buildFieldPhraseVariants(metadata);

  return Array.from(
    new Set([
      ...hint.matchPhrases,
      ...(hint.matchFieldPhrases ?? []).flatMap((template) =>
        fieldPhrases.map((phrase) => template.replaceAll("{field}", phrase))
      )
    ])
  )
    .map(normalizeText)
    .filter((value) => value.length > 0);
}

function selectDraftProposalHint(
  metadata: WorkflowConditionBindingMetadata,
  businessRule: string,
  fieldIds: readonly string[]
): WorkflowConditionBindingMetadata["proposalHints"][number] | null {
  if (!mentionsBinding(metadata.binding, metadata, businessRule, fieldIds)) {
    return null;
  }

  const supported = new Set(metadata.supportedOperatorIds);
  const normalizedRule = normalizeText(businessRule);

  for (const hint of metadata.proposalHints) {
    if (!supported.has(hint.operatorId)) {
      continue;
    }

    if (buildProposalHintPhrases(metadata, hint).some((phrase) => normalizedRule.includes(phrase))) {
      return hint;
    }
  }

  return null;
}

export function draftWorkflowConditionsFromMetadata(
  authoringMetadata: WorkflowAuthoringMetadata,
  input: {
    businessRule: string;
    fieldIds?: readonly string[];
  }
): WorkflowConditionBinding[] {
  const fieldIds = input.fieldIds ?? [];
  const draftedConditions: WorkflowConditionBinding[] = [];
  const draftedBindingKeys = new Set<string>();

  for (const [bindingName, metadata] of Object.entries(authoringMetadata.bindings)) {
    const proposalHint = selectDraftProposalHint(metadata, input.businessRule, fieldIds);
    if (proposalHint === null) {
      continue;
    }

    const fieldDraftKey = `${metadata.fieldId}:${proposalHint.operatorId}`;
    if (draftedBindingKeys.has(fieldDraftKey)) {
      continue;
    }

    const baseInput: WorkflowConditionBinding["input"] = {
      fieldId: {
        path: metadata.template.fieldIdPath
      },
      fieldType: {
        path: metadata.template.fieldTypePath
      },
      value: {
        path: metadata.template.valuePath
      }
    };
    draftedConditions.push({
      input: {
        ...baseInput,
        ...(proposalHint.draftInput ?? {})
      },
      operatorId: proposalHint.operatorId
    });
    draftedBindingKeys.add(fieldDraftKey);
  }

  return draftedConditions;
}
