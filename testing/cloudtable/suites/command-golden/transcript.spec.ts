import { describe, expect, it } from "vitest";

import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import {
  executeCommandFixture,
  toExpectedCommandResult
} from "../../harness/runners/command-fixture-executor";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

describe("cloudtable command fixture executor", () => {
  for (const scenarioId of listCommandFixtureScenarioIds()) {
    const fixture = loadCommandFixture(scenarioId);

    it(`matches fixture ${scenarioId}`, async () => {
      const actual = await executeCommandFixture(fixture);

      expect(toCanonicalJson(actual)).toBe(
        toCanonicalJson(toExpectedCommandResult(fixture))
      );
    });
  }
});
