import { createFieldTypeRegistry } from "../field-types/registry";
import type { FieldTypeRegistry } from "../field-types/types";
import { createCloudTableD1Repository } from "../persistence/cloudtable-d1-repository";
import type { EventLedger } from "./types";

export function createEventLedger(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry = createFieldTypeRegistry()
): EventLedger {
  const repository = createCloudTableD1Repository(db, fieldTypeRegistry);

  return {
    async now(): Promise<string> {
      return new Date().toISOString();
    },

    async findReceipt(scopeKey, idempotencyKey) {
      return repository.findReceipt(scopeKey, idempotencyKey);
    },

    async commitAcceptedCommand(commit) {
      return repository.commitAcceptedCommand(commit);
    }
  };
}
