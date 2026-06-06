import { createCloudTableD1Repository } from "../persistence/cloudtable-d1-repository";
import type { EventLedger } from "./types";

export function createEventLedger(db: D1Database): EventLedger {
  const repository = createCloudTableD1Repository(db);

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
