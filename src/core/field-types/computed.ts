import type { JsonValue } from "./types";

export type ComputedRollupGrouping =
  | {
      sourceFieldId: string;
      strategy: "single_relation";
    }
  | {
      sourceFieldId: string;
      strategy: "value_match";
      targetFieldId: string;
    };

export type ComputedRollupConfig = {
  grouping: ComputedRollupGrouping;
  operandFieldId?: string;
  operationConfig?: Record<string, JsonValue>;
  operationId: string;
  sourceTableId: string;
};

export type ComputedLookupConfig = {
  sourceFieldId: string;
  targetFieldId: string;
};

export type ComputedFieldConfig = {
  dependsOnFieldIds?: readonly string[];
  expression?: string;
  lookup?: ComputedLookupConfig;
  resultValueType?: string;
  rollup?: ComputedRollupConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readDependencyFieldIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids = Array.from(
    new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    )
  );

  return ids.length > 0 ? ids : undefined;
}

function readOperationConfig(value: unknown): Record<string, JsonValue> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value as Record<string, JsonValue>;
}

export function readComputedFieldConfig(config: unknown): ComputedFieldConfig | null {
  if (!isRecord(config)) {
    return null;
  }

  const rollupValue = isRecord(config.rollup) ? config.rollup : null;
  const groupingValue = rollupValue && isRecord(rollupValue.grouping) ? rollupValue.grouping : null;

  const rollup: ComputedRollupConfig | undefined =
    rollupValue && groupingValue
      ? {
          grouping:
            groupingValue.strategy === "value_match"
              ? {
                  sourceFieldId: readString(groupingValue.sourceFieldId) ?? "",
                  strategy: "value_match",
                  targetFieldId: readString(groupingValue.targetFieldId) ?? ""
                }
              : {
                  sourceFieldId: readString(groupingValue.sourceFieldId) ?? "",
                  strategy: "single_relation"
                },
          ...(readString(rollupValue.operandFieldId)
            ? {
                operandFieldId: readString(rollupValue.operandFieldId)
              }
            : {}),
          ...(readOperationConfig(rollupValue.operationConfig)
            ? {
                operationConfig: readOperationConfig(rollupValue.operationConfig)
              }
            : {}),
          operationId: readString(rollupValue.operationId) ?? "",
          sourceTableId: readString(rollupValue.sourceTableId) ?? ""
        }
      : undefined;
  const lookupValue = isRecord(config.lookup) ? config.lookup : null;
  const lookup: ComputedLookupConfig | undefined = lookupValue
    ? {
        sourceFieldId: readString(lookupValue.sourceFieldId) ?? "",
        targetFieldId: readString(lookupValue.targetFieldId) ?? ""
      }
    : undefined;

  return {
    ...(readDependencyFieldIds(config.dependsOnFieldIds)
      ? { dependsOnFieldIds: readDependencyFieldIds(config.dependsOnFieldIds) }
      : {}),
    ...(readString(config.expression) ? { expression: readString(config.expression) } : {}),
    ...(lookup ? { lookup } : {}),
    ...(readString(config.resultValueType)
      ? { resultValueType: readString(config.resultValueType) }
      : {}),
    ...(rollup ? { rollup } : {})
  };
}
