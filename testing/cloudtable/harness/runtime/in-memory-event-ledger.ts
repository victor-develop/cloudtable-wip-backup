import type { IdempotencyReceipt } from "../../../../src/core/commands/types";
import type { EventLedger, EventLedgerCommit } from "../../../../src/core/events/types";

export class InMemoryEventLedger implements EventLedger {
  private readonly receiptMap = new Map<string, IdempotencyReceipt[]>();

  constructor(
    private readonly logicalTime: string,
    seededReceipts: IdempotencyReceipt[] = []
  ) {
    this.receiptMap.set(
      "seed",
      seededReceipts.map((receipt) => structuredClone(receipt))
    );
  }

  async now(): Promise<string> {
    return this.logicalTime;
  }

  async findReceipt(
    scopeKey: string,
    idempotencyKey: string
  ): Promise<IdempotencyReceipt | null> {
    const receipts = this.receiptsFor(scopeKey);
    return (
      receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey) ?? null
    );
  }

  async commitAcceptedCommand(commit: EventLedgerCommit) {
    const receipts = this.receiptsFor(commit.scopeKey);
    receipts.push(structuredClone(commit.receipt));
    this.receiptMap.set(commit.scopeKey, receipts);

    return {
      event: commit.event,
      receipts: receipts.map((receipt) => structuredClone(receipt))
    };
  }

  snapshotReceipts(scopeKey: string): IdempotencyReceipt[] {
    return this.receiptsFor(scopeKey).map((receipt) => structuredClone(receipt));
  }

  private receiptsFor(scopeKey: string): IdempotencyReceipt[] {
    const seeded = this.receiptMap.get(scopeKey);
    if (seeded) {
      return seeded.map((receipt) => structuredClone(receipt));
    }

    const defaultSeed = this.receiptMap.get("seed") ?? [];
    const receipts = defaultSeed.map((receipt) => structuredClone(receipt));
    this.receiptMap.set(scopeKey, receipts);
    this.receiptMap.delete("seed");
    return receipts;
  }
}
