import { describe, expect, it } from "vitest";

import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import { executeCommandFixture } from "../../harness/runners/command-transcript";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

describe("cloudtable command transcript harness", () => {
  for (const scenarioId of listCommandFixtureScenarioIds()) {
    const fixture = loadCommandFixture(scenarioId);

    if (fixture.seedState.persistence) {
      it.skip(`matches fixture ${scenarioId}`, () => {});
      continue;
    }

    it(`matches fixture ${scenarioId}`, () => {
      const actual = executeCommandFixture(fixture);

      expect(toCanonicalJson(actual)).toBe(toCanonicalJson(fixture.expected));
    });
  }
});
