import type { JsonValue } from "../field-types/types";
import type {
  AggregateOperationDefinition,
  AggregateOperationInput,
  AggregateOperationRegistry
} from "./types";

function countRecordsOperation(): AggregateOperationDefinition {
  return {
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
    id: "sum_numbers",
    evaluate(input: AggregateOperationInput): JsonValue {
      return input.rows.reduce((total, row) => {
        return Number.isFinite(row.numericValue) ? total + (row.numericValue ?? 0) : total;
      }, 0);
    }
  };
}

const defaultOperations = [countRecordsOperation(), sumNumbersOperation()] as const;

export function createAggregateOperationRegistry(
  definitions: readonly AggregateOperationDefinition[] = defaultOperations
): AggregateOperationRegistry {
  const byId = new Map(definitions.map((definition) => [definition.id, definition] as const));

  return {
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
