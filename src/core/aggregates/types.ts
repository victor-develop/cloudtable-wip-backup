import type { JsonValue } from "../field-types/types";

export type AggregateSourceRow = {
  numericValue: number | null;
  recordId: string;
  targetRecordId: string | null;
};

export type AggregateOperationInput = {
  config: Record<string, JsonValue>;
  rows: readonly AggregateSourceRow[];
};

export type AggregateOperationDefinition = {
  evaluate(input: AggregateOperationInput): JsonValue;
  id: string;
  validateConfig?(config: Record<string, JsonValue>): readonly string[];
};

export type AggregateOperationRegistry = {
  list(): readonly AggregateOperationDefinition[];
  require(id: string): AggregateOperationDefinition;
};
