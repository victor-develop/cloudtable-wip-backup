import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { EventLedger } from "../../../../src/core/events/types";
import { mvpFieldTypes } from "../../../../src/core/field-types/modules";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import type { FieldTypeDefinition } from "../../../../src/core/field-types/types";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import { createViewPlanner } from "../../../../src/core/views/planner";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { mvpWorkflowOperators } from "../../../../src/core/workflows/operators";
import { createDeterministicRuntime } from "../../harness/runtime/deterministic-runtime";

const noopEventLedger: EventLedger = {
  async now() {
    return "2026-06-06T00:00:00.000Z";
  },
  async findReceipt() {
    return null;
  },
  async commitAcceptedCommand() {
    throw new Error("Event ledger commit is not exercised in scaffold smoke tests.");
  }
};

function assertFieldTypeFixtures(fieldType: FieldTypeDefinition): void {
  expect(fieldType.validateConfig(fieldType.defaultConfig, { fieldType: fieldType.type }).valid).toBe(true);

  for (const fixture of fieldType.fixtures) {
    if (fixture.kind === "normalize") {
      const normalized = fieldType.normalize(fixture.input, {
        fieldConfig: fieldType.defaultConfig,
        fieldType: fieldType.type
      });

      expect(normalized).toEqual({
        value: fixture.expected.value,
        warnings: fixture.expected.warnings ?? []
      });
      expect(
        fieldType.validateValue(normalized.value, {
          fieldConfig: fieldType.defaultConfig,
          fieldType: fieldType.type
        })
      ).toEqual({
        valid: true,
        errors: []
      });
      expect(
        fieldType.toDisplay(normalized.value, {
          fieldConfig: fieldType.defaultConfig,
          fieldType: fieldType.type
        })
      ).toBe(
        fixture.expected.display
      );
      expect(
        fieldType.toSearchText(normalized.value, {
          fieldConfig: fieldType.defaultConfig,
          fieldType: fieldType.type
        })
      ).toBe(
        fixture.expected.searchText
      );
      expect(
        fieldType.toIndex(normalized.value, {
          fieldConfig: fieldType.defaultConfig,
          fieldType: fieldType.type
        })
      ).toEqual(
        fixture.expected.index
      );
      continue;
    }

    if (fixture.kind === "invalid_config") {
      expect(
        fieldType.validateConfig(fixture.config, {
          fieldType: fieldType.type
        })
      ).toEqual({
        valid: false,
        errors: fixture.expectedErrors
      });
      continue;
    }

    if (fixture.kind === "invalid_value") {
      const fieldConfig = fixture.fieldConfig ?? fieldType.defaultConfig;

      if ("input" in fixture) {
        const normalized = fieldType.normalize(fixture.input, {
          fieldConfig,
          fieldType: fieldType.type
        });

        expect(normalized).toEqual({
          value: fixture.expected.value,
          warnings: fixture.expected.warnings ?? []
        });
        expect(
          fieldType.validateValue(normalized.value, {
            fieldConfig,
            fieldType: fieldType.type
          })
        ).toEqual({
          valid: false,
          errors: fixture.expected.errors
        });
        continue;
      }

      expect(
        fieldType.validateValue(fixture.value, {
          fieldConfig,
          fieldType: fieldType.type
        })
      ).toEqual({
        valid: false,
        errors: fixture.expected.errors
      });
      continue;
    }

    if (fixture.kind === "operators") {
      expect(fieldType.getSupportedConditionOperators({ fieldType: fieldType.type })).toEqual(
        fixture.expectedConditionOperators
      );
      expect(fieldType.getSupportedSortModes({ fieldType: fieldType.type })).toEqual(
        fixture.expectedSortModes
      );
      continue;
    }

    expect(fieldType.getPermissionBehavior({ fieldType: fieldType.type })).toEqual(
      fixture.expected
    );
  }
}

function buildCustomFieldType(): FieldTypeDefinition {
  return {
    ...mvpFieldTypes[0],
    type: "rating.stars",
    supportedConditionOperators: ["equals", "number_compare"],
    supportedSortModes: ["ascending", "descending"],
    normalize(input) {
      const numeric = Number(input);

      return {
        value: {
          valueType: "rating.stars",
          version: 1,
          raw: String(numeric),
          isEmpty: false,
          meta: {
            stars: numeric
          }
        },
        warnings: []
      };
    },
    toDisplay(value) {
      const count = Number(value?.raw ?? 0);

      return "★".repeat(count);
    },
    toIndex(value) {
      const raw = typeof value?.raw === "string" ? value.raw : null;

      return {
        numberValue: raw,
        displayValue: "★".repeat(Number(raw ?? 0)),
        searchText: raw ?? "",
        valueHash: JSON.stringify(value?.raw ?? null)
      };
    },
    toSearchText(value) {
      return typeof value?.raw === "string" ? value.raw : "";
    },
    getSupportedConditionOperators() {
      return ["equals", "number_compare"];
    },
    getWorkflowProposalHints(context) {
      return mvpFieldTypes[0].getWorkflowProposalHints(context);
    },
    getSupportedSortModes() {
      return ["ascending", "descending"];
    },
    fixtures: [
      {
        id: "rating.stars.normalize.sample",
        kind: "normalize",
        input: 5,
        expected: {
          value: {
            valueType: "rating.stars",
            version: 1,
            raw: "5",
            isEmpty: false,
            meta: {
              stars: 5
            }
          },
          warnings: [],
          display: "★★★★★",
          searchText: "5",
          index: {
            numberValue: "5",
            displayValue: "★★★★★",
            searchText: "5",
            valueHash: "\"5\""
          }
        }
      },
      {
        id: "rating.stars.operators.sample",
        kind: "operators",
        expectedConditionOperators: ["equals", "number_compare"],
        expectedSortModes: ["ascending", "descending"]
      },
      {
        id: "rating.stars.permission.sample",
        kind: "permission",
        expected: {
          readRedaction: "none",
          allowsMutation: true,
          allowsWorkflowTrigger: true,
          supportsValueVisibilityRules: false
        }
      },
      {
        id: "rating.stars.invalid_config.out_of_range",
        kind: "invalid_config",
        config: { maxStars: 10 },
        expectedErrors: ["Rating stars fixture should reject invalid config."]
      },
      {
        id: "rating.stars.invalid_value.too_many_stars",
        kind: "invalid_value",
        fieldConfig: { maxStars: 5 },
        input: 6,
        expected: {
          value: {
            valueType: "rating.stars",
            version: 1,
            raw: "6",
            isEmpty: false,
            meta: {
              stars: 6
            }
          },
          warnings: [],
          errors: ["Rating stars fixture should reject invalid value."]
        }
      }
    ],
    validateConfig(config) {
      const hasMaxStars =
        typeof config === "object" && config !== null && "maxStars" in config;

      return {
        valid: !hasMaxStars,
        errors: hasMaxStars
          ? ["Rating stars fixture should reject invalid config."]
          : []
      };
    },
    validateValue(value, context) {
      const maxStars = Number((context.fieldConfig as { maxStars?: number } | undefined)?.maxStars ?? 5);
      const stars = Number(value?.raw ?? 0);

      return {
        valid: stars <= maxStars,
        errors: stars <= maxStars ? [] : ["Rating stars fixture should reject invalid value."]
      };
    }
  };
}

describe("cloudtable scaffold", () => {
  it("registers MVP field types and workflow operators with deterministic lookup", () => {
    const registry = createFieldTypeRegistry();
    const fieldTypes = registry.list();
    const workflowOperators = createWorkflowOperatorRegistry().list();

    expect(fieldTypes).toHaveLength(12);
    expect(fieldTypes.map((fieldType) => fieldType.type)).toEqual(mvpFieldTypes.map((fieldType) => fieldType.type));
    expect(registry.has("text.single_line")).toBe(true);
    expect(registry.get("missing.field_type")).toBeUndefined();
    expect(() => registry.require("missing.field_type")).toThrow("Unknown field type: missing.field_type");
    expect(workflowOperators).toHaveLength(mvpWorkflowOperators.length);
    expect(workflowOperators.map((operator) => operator.id)).toEqual(
      mvpWorkflowOperators.map((operator) => operator.id)
    );
    expect(workflowOperators.filter((operator) => operator.kind === "trigger")).toHaveLength(5);
    expect(workflowOperators.filter((operator) => operator.kind === "condition")).toHaveLength(13);
    expect(workflowOperators.filter((operator) => operator.kind === "action")).toHaveLength(7);
    expect(createWorkflowOperatorRegistry().has("equals")).toBe(true);
    expect(() => createWorkflowOperatorRegistry().require("missing.workflow_operator")).toThrow(
      "Unknown workflow operator: missing.workflow_operator"
    );
  });

  it("runs deterministic MVP field fixtures", () => {
    const registry = createFieldTypeRegistry();

    for (const fieldType of registry.list()) {
      assertFieldTypeFixtures(fieldType);
    }
  });

  it("executes invalid-config and invalid-value fixtures through the shared runner", () => {
    assertFieldTypeFixtures(buildCustomFieldType());
  });

  it("rejects duplicate registrations and duplicate fixture ids at startup", () => {
    expect(() =>
      createFieldTypeRegistry({
        fieldTypes: [mvpFieldTypes[0], mvpFieldTypes[0]]
      })
    ).toThrow("Duplicate field type registration: text.single_line");

    expect(() =>
      createFieldTypeRegistry({
        fieldTypes: [
          {
            ...mvpFieldTypes[0],
            type: "fixture.duplicate",
            fixtures: [
              {
                ...mvpFieldTypes[0].fixtures[0],
                id: "fixture.duplicate.shared"
              },
              {
                ...mvpFieldTypes[0].fixtures[1],
                id: "fixture.duplicate.shared"
              }
            ]
          }
        ]
      })
    ).toThrow("Duplicate fixture id for fixture.duplicate: fixture.duplicate.shared");

    expect(() =>
      createWorkflowOperatorRegistry({
        definitions: [mvpWorkflowOperators[0], mvpWorkflowOperators[0]]
      })
    ).toThrow("Duplicate workflow operator registration: record_created");

    expect(() =>
      createWorkflowOperatorRegistry({
        definitions: [
          {
            ...mvpWorkflowOperators[0],
            id: "workflow.fixture.duplicate",
            fixtureContract: [
              {
                id: "workflow.fixture.shared",
                kind: "condition",
                input: {
                  value: true
                },
                expected: true
              },
              {
                id: "workflow.fixture.shared",
                kind: "condition",
                input: {
                  value: false
                },
                expected: false
              }
            ]
          }
        ]
      })
    ).toThrow(
      "Duplicate fixture id for workflow operator workflow.fixture.duplicate: workflow.fixture.shared"
    );
  });

  it("lets command, view, and permission scaffolds consume a new field type without core edits", () => {
    const customFieldType = buildCustomFieldType();
    const registry = createFieldTypeRegistry({
      fieldTypes: [...mvpFieldTypes, customFieldType]
    });
    const permissionEngine = createPermissionEngine(registry);
    const viewPlanner = createViewPlanner(registry, permissionEngine);
    const commandBus = createCommandBus({
      eventLedger: noopEventLedger,
      fieldTypeRegistry: registry,
      permissionEngine,
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    expect(commandBus.normalizeFieldValue("rating.stars", 5)).toEqual({
      value: {
        valueType: "rating.stars",
        version: 1,
        raw: "5",
        isEmpty: false,
        meta: {
          stars: 5
        }
      },
      warnings: []
    });
    expect(viewPlanner.describeField("rating.stars")).toEqual({
      capabilities: customFieldType.capabilities,
      supportedConditionOperators: ["equals", "number_compare"],
      supportedSortModes: ["ascending", "descending"]
    });
    expect(permissionEngine.describeField("rating.stars")).toEqual({
      readRedaction: "none",
      allowsMutation: true,
      allowsWorkflowTrigger: true,
      supportsValueVisibilityRules: false
    });
  });

  it("ships deterministic runtime primitives", () => {
    const runtime = createDeterministicRuntime(7);

    expect(runtime.now()).toBe("2026-06-06T00:00:00.000Z");
    expect(runtime.nextId("evt")).toBe("evt_0001");
    expect(runtime.random()).toBeGreaterThan(0);
    expect(runtime.random()).toBeLessThan(1);
  });

  it("includes the initial schema migration", () => {
    const migrationPath = resolve(process.cwd(), "migrations/0001_initial_schema.sql");

    expect(existsSync(migrationPath)).toBe(true);
    expect(readFileSync(migrationPath, "utf8")).toContain("CREATE TABLE IF NOT EXISTS event_ledger");
    expect(readFileSync(migrationPath, "utf8")).toContain("CREATE TABLE IF NOT EXISTS workflow_runs");
  });
});
