import type { JsonSchema, JsonValue } from "../field-types/types";

export type AggregateSourceRow = {
  numericValue: number | null;
  recordId: string;
  targetRecordId: string | null;
};

export type AggregateOperationInput = {
  config: Record<string, JsonValue>;
  rows: readonly AggregateSourceRow[];
};

export type AggregateOperationOperandManifest = {
  description: string;
  required: boolean;
  valueType: "number";
};

export type AggregateOperationManifest = {
  configSchema: JsonSchema;
  description: string;
  id: string;
  operand?: AggregateOperationOperandManifest;
};

export type AggregateOperationDefinition = {
  configSchema: JsonSchema;
  description: string;
  evaluate(input: AggregateOperationInput): JsonValue;
  id: string;
  operand?: AggregateOperationOperandManifest;
  validateConfig?(config: Record<string, JsonValue>): readonly string[];
};

export type AggregateOperationRegistry = {
  get(id: string): AggregateOperationDefinition | undefined;
  has(id: string): boolean;
  list(): readonly AggregateOperationDefinition[];
  require(id: string): AggregateOperationDefinition;
};
