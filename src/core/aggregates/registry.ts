import type { JsonValue } from "../field-types/types";
import type {
  AggregateOperationDefinition,
  AggregateOperationInput,
  AggregateOperationRegistry
} from "./types";

function countRecordsOperation(): AggregateOperationDefinition {
  return {
    configSchema: {
      additionalProperties: false,
      description: "Counts grouped source rows. includeArchived is reserved for future archived-row semantics.",
      properties: {
        includeArchived: {
          description: "Reserved flag for future archived-row inclusion semantics.",
          type: "boolean"
        }
      },
      type: "object"
    },
    description: "Counts grouped source rows.",
    id: "count_records",
    evaluate(input: AggregateOperationInput): JsonValue {
      return input.rows.length;
    },
    validateConfig(config) {
      const diagnostics: string[] = [];
      const includeArchived = config.includeArchived;
      if (
        typeof includeArchived !== "undefined" &&
        typeof includeArchived !== "boolean"
      ) {
        diagnostics.push("includeArchived must be a boolean when provided.");
      }
      return diagnostics;
    }
  };
}

function sumNumbersOperation(): AggregateOperationDefinition {
  return {
    configSchema: {
      additionalProperties: false,
      description: "Sums finite numeric operand values across grouped source rows.",
      properties: {},
      type: "object"
    },
    description: "Sums finite numeric operand values across grouped source rows.",
    id: "sum_numbers",
    operand: {
      description: "Numeric source field whose finite values are summed.",
      required: true,
      valueType: "number"
    },
    evaluate(input: AggregateOperationInput): JsonValue {
      return input.rows.reduce((total, row) => {
        return Number.isFinite(row.numericValue) ? total + (row.numericValue ?? 0) : total;
      }, 0);
    }
  };
}

function maxNumberOperation(): AggregateOperationDefinition {
  return {
    configSchema: {
      additionalProperties: false,
      description:
        "Returns the maximum finite numeric operand value across grouped source rows, or null when none exist.",
      properties: {},
      type: "object"
    },
    description:
      "Returns the maximum finite numeric operand value across grouped source rows, or null when none exist.",
    id: "max_number",
    operand: {
      description: "Numeric source field whose finite values are reduced by maximum.",
      required: true,
      valueType: "number"
    },
    evaluate(input: AggregateOperationInput): JsonValue {
      const values = input.rows
        .map((row) => row.numericValue)
        .filter((value): value is number => Number.isFinite(value));

      return values.length > 0 ? Math.max(...values) : null;
    }
  };
}

function averageNumbersOperation(): AggregateOperationDefinition {
  return {
    configSchema: {
      additionalProperties: false,
      description:
        "Returns the arithmetic mean of finite numeric operand values across grouped source rows, or null when none exist.",
      properties: {},
      type: "object"
    },
    description:
      "Returns the arithmetic mean of finite numeric operand values across grouped source rows, or null when none exist.",
    id: "average_numbers",
    operand: {
      description: "Numeric source field whose finite values are reduced by arithmetic mean.",
      required: true,
      valueType: "number"
    },
    evaluate(input: AggregateOperationInput): JsonValue {
      const values = input.rows
        .map((row) => row.numericValue)
        .filter((value): value is number => Number.isFinite(value));

      if (values.length === 0) {
        return null;
      }

      return values.reduce((total, value) => total + value, 0) / values.length;
    }
  };
}

const defaultOperations = [
  countRecordsOperation(),
  sumNumbersOperation(),
  maxNumberOperation(),
  averageNumbersOperation()
] as const;

export function createAggregateOperationRegistry(
  definitions: readonly AggregateOperationDefinition[] = defaultOperations
): AggregateOperationRegistry {
  const byId = new Map(definitions.map((definition) => [definition.id, definition] as const));

  return {
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    list() {
      return definitions;
    },
    require(id) {
      const definition = byId.get(id);
      if (!definition) {
        throw new Error(`Unknown aggregate operation: ${id}`);
      }

      return definition;
    }
  };
}
