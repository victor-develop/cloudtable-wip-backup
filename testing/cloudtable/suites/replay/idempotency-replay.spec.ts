import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import { scopeKeyForCommand } from "../../../../src/core/commands/transcript";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

const replayableScenarioIds = listCommandFixtureScenarioIds().filter((scenarioId) => {
  const fixture = loadCommandFixture(scenarioId);
  const existingReceipt = (fixture.seedState.receipts ?? []).find(
    (receipt) => receipt.idempotencyKey === fixture.command.idempotencyKey
  );

  return fixture.expected.accepted && !existingReceipt;
});

describe("cloudtable replay harness", () => {
  for (const scenarioId of replayableScenarioIds) {
    it(`replays accepted receipt state for ${scenarioId}`, async () => {
      const fixture = loadCommandFixture(scenarioId);
      const logicalTime = fixture.meta.logicalStartTime;
      const scopeKey = scopeKeyForCommand(fixture.command);
      const fieldTypeRegistry = createFieldTypeRegistry();
      const workflowOperatorRegistry = createWorkflowOperatorRegistry();
      const permissionEngine = createPermissionEngine(fieldTypeRegistry);
      const firstLedger = new InMemoryEventLedger(logicalTime);
      const firstBus = createCommandBus({
        eventLedger: firstLedger,
        fieldTypeRegistry,
        permissionEngine,
        workflowOperatorRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        }
      });

      const firstResult = await firstBus.execute(fixture.command);
      expect(firstResult.accepted).toBe(true);

      const replayLedger = new InMemoryEventLedger(
        logicalTime,
        firstLedger.snapshotReceipts(scopeKey)
      );
      const replayBus = createCommandBus({
        eventLedger: replayLedger,
        fieldTypeRegistry,
        permissionEngine,
        workflowOperatorRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        }
      });

      const replayResult = await replayBus.execute(fixture.command);

      expect(replayResult.diagnostics).toEqual(["idempotent_replay"]);
      expect(toCanonicalJson(replayResult.events)).toBe(
        toCanonicalJson(firstResult.events)
      );
      expect(toCanonicalJson(replayResult.sideEffects)).toBe(
        toCanonicalJson(firstResult.sideEffects)
      );
      expect(replayResult.permission).toEqual(firstResult.permission);
      expect(replayResult.replayProjection.receiptCount).toBe(1);
      expect(replayResult.replayProjection.receipts).toEqual(
        firstResult.replayProjection.receipts
      );
    });
  }
});
