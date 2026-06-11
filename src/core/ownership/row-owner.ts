import type { JsonValue } from "../field-types/types";

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

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, JsonValue>;
}

export function isRowOwnerEnabled(config: JsonValue): boolean {
  return asRecord(config)?.rowOwner === true;
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

export function listCanonicalWorkflowBindingAliases<T extends RowOwnerCandidate>(
  fields: readonly T[]
): readonly CanonicalWorkflowBindingAlias<T>[] {
  const rowOwnerField = findRowOwnerField(fields);
  if (!rowOwnerField) {
    return [];
  }

  return [
    {
      aliasOf: `row.fields.${rowOwnerField.fieldKey}`,
      binding: "row.owner",
      field: rowOwnerField,
      isCanonical: true
    }
  ];
}
