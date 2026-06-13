import type { FieldWorkflowBindingAlias, JsonValue } from "../field-types/types";

export type RowOwnerCandidate = {
  config: JsonValue;
  fieldId: string;
  fieldKey: string;
  fieldType: string;
};

export type CanonicalWorkflowBindingAlias<T extends RowOwnerCandidate = RowOwnerCandidate> = {
  aliasOf: string;
  binding: string;
  field: T;
  isCanonical: true;
};

export type CanonicalWorkflowBindingAliasConflict<
  T extends RowOwnerCandidate = RowOwnerCandidate
> = {
  binding: string;
  fields: readonly T[];
};

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, JsonValue>;
}

export function isRowOwnerEnabled(config: JsonValue): boolean {
  return asRecord(config)?.rowOwner === true;
}

export function listPrincipalUserCanonicalBindings(
  config: JsonValue
): readonly FieldWorkflowBindingAlias[] {
  const parsed = asRecord(config);
  if (!parsed) {
    return [];
  }

  const bindings: FieldWorkflowBindingAlias[] = [];
  if (parsed.rowOwner === true) {
    bindings.push({
      binding: "row.owner",
      isCanonical: true
    });
  }

  if (typeof parsed.workflowBindingAlias === "string") {
    const binding = parsed.workflowBindingAlias.trim();
    if (binding.length > 0 && !bindings.some((entry) => entry.binding === binding)) {
      bindings.push({
        binding,
        isCanonical: true
      });
    }
  }

  return bindings;
}

export function findRowOwnerField<T extends RowOwnerCandidate>(
  fields: readonly T[]
): T | null {
  const matches = fields.filter(
    (field) => field.fieldType === "principal.user" && isRowOwnerEnabled(field.config)
  );
  if (matches.length === 0) {
    return null;
  }

  return [...matches].sort((left, right) => left.fieldId.localeCompare(right.fieldId))[0] ?? null;
}

export function findCanonicalWorkflowBindingAliasConflicts<T extends RowOwnerCandidate>(
  fields: readonly T[]
): readonly CanonicalWorkflowBindingAliasConflict<T>[] {
  const fieldsByBinding = new Map<string, T[]>();

  for (const field of [...fields].sort((left, right) => left.fieldId.localeCompare(right.fieldId))) {
    if (field.fieldType !== "principal.user") {
      continue;
    }

    for (const binding of listPrincipalUserCanonicalBindings(field.config)) {
      const matches = fieldsByBinding.get(binding.binding) ?? [];
      matches.push(field);
      fieldsByBinding.set(binding.binding, matches);
    }
  }

  return [...fieldsByBinding.entries()]
    .filter(([, matchingFields]) => matchingFields.length > 1)
    .sort(([leftBinding], [rightBinding]) => leftBinding.localeCompare(rightBinding))
    .map(([binding, matchingFields]) => ({
      binding,
      fields: [...matchingFields].sort((left, right) => left.fieldId.localeCompare(right.fieldId))
    }));
}

export function formatCanonicalWorkflowBindingAliasConflictDiagnostic<
  T extends RowOwnerCandidate
>(conflict: CanonicalWorkflowBindingAliasConflict<T>): string {
  return `canonical_workflow_binding_alias_conflict:${conflict.binding}:${conflict.fields
    .map((field) => field.fieldId)
    .join(":")}`;
}

export function listCanonicalWorkflowBindingAliases<T extends RowOwnerCandidate>(
  fields: readonly T[]
): readonly CanonicalWorkflowBindingAlias<T>[] {
  const conflicts = findCanonicalWorkflowBindingAliasConflicts(fields);
  if (conflicts.length > 0) {
    throw new Error(formatCanonicalWorkflowBindingAliasConflictDiagnostic(conflicts[0]!));
  }

  const rowOwnerField = findRowOwnerField(fields);
  const aliases: CanonicalWorkflowBindingAlias<T>[] = [];
  const seenBindings = new Set<string>();

  for (const field of [...fields].sort((left, right) => left.fieldId.localeCompare(right.fieldId))) {
    if (field.fieldType !== "principal.user") {
      continue;
    }

    for (const binding of listPrincipalUserCanonicalBindings(field.config)) {
      if (binding.binding === "row.owner" && rowOwnerField?.fieldId !== field.fieldId) {
        continue;
      }

      if (seenBindings.has(binding.binding)) {
        continue;
      }

      seenBindings.add(binding.binding);
      aliases.push({
        aliasOf: `row.fields.${field.fieldKey}`,
        binding: binding.binding,
        field,
        isCanonical: true
      });
    }
  }

  return aliases;
}
