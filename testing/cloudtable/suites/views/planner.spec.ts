import { describe, expect, it } from "vitest";

import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { createViewPlanner } from "../../../../src/core/views/planner";

const fieldTypeRegistry = createFieldTypeRegistry();
const snapshot: EffectivePermissionSnapshot = {
  snapshotId: "snap_view_001",
  workspaceId: "ws_demo",
  principalId: "usr_alice",
  policyRevision: 7,
  schemaEpoch: 3,
  scopeHash: "scope:view:view_pipeline",
  fields: {
    account_name: {
      fieldId: "account_name",
      fieldType: "text.single_line",
      read: "visible",
      write: true,
      workflow: true,
      agent: true
    },
    salary: {
      fieldId: "salary",
      fieldType: "number.decimal",
      read: "hidden",
      write: false,
      workflow: false,
      agent: false
    },
    customer_note: {
      fieldId: "customer_note",
      fieldType: "text.long",
      read: "redacted",
      write: true,
      workflow: true,
      agent: false
    },
    lifecycle_state: {
      fieldId: "lifecycle_state",
      fieldType: "status.semantic",
      read: "visible",
      write: true,
      workflow: true,
      agent: true
    },
    health_score: {
      fieldId: "health_score",
      fieldType: "computed.readonly",
      read: "visible",
      write: false,
      workflow: true,
      agent: true
    }
  }
};
const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
  snapshot
});
const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);

describe("cloudtable view determinism seam", () => {
  it("describes the stable view planner dependencies", () => {
    expect(viewPlanner.describe()).toEqual({
      consistencyModel: "view_eventual",
      dependsOn: ["record_projection", "field_index_entries", "permission_engine"]
    });
  });

  it("builds a permission-aware view plan that blocks hidden and redacted constraints", () => {
    const plan = viewPlanner.planQuery(
      [
        {
          fieldId: "account_name",
          fieldType: "text.single_line"
        },
        {
          fieldId: "salary",
          fieldType: "number.decimal"
        },
        {
          fieldId: "customer_note",
          fieldType: "text.long"
        },
        {
          fieldId: "lifecycle_state",
          fieldType: "status.semantic"
        },
        {
          fieldId: "health_score",
          fieldType: "computed.readonly"
        }
      ],
      [
        {
          fieldId: "account_name",
          fieldType: "text.single_line",
          kind: "filter"
        },
        {
          fieldId: "salary",
          fieldType: "number.decimal",
          kind: "sort"
        },
        {
          fieldId: "customer_note",
          fieldType: "text.long",
          kind: "group"
        }
      ]
    );

    expect(plan).toEqual({
      allowed: false,
      blockedFieldIds: ["salary", "customer_note"],
      diagnostics: [
        "view_hidden:salary",
        "view_redacted:customer_note",
        "view_constraint_hidden:salary",
        "view_constraint_hidden:customer_note"
      ],
      filterableFieldIds: ["account_name", "lifecycle_state", "health_score"],
      groupableFieldIds: ["account_name", "lifecycle_state", "health_score"],
      hiddenFieldIds: ["salary"],
      redactedFieldIds: ["customer_note"],
      redactionApplied: true,
      sortableFieldIds: ["account_name", "lifecycle_state", "health_score"],
      visibleFieldIds: [
        "account_name",
        "customer_note",
        "lifecycle_state",
        "health_score"
      ]
    });
  });

  it("projects view rows through the permission engine redaction surface", () => {
    const projection = viewPlanner.projectRow([
      {
        fieldId: "account_name",
        fieldType: "text.single_line",
        value: "Acme"
      },
      {
        fieldId: "salary",
        fieldType: "number.decimal",
        value: "120000"
      },
      {
        fieldId: "customer_note",
        fieldType: "text.long",
        value: "VIP renewal risk"
      }
    ]);

    expect(projection.fields).toEqual({
      account_name: "Acme",
      customer_note: "[redacted]"
    });
    expect(projection.hiddenFieldIds).toEqual(["salary"]);
    expect(projection.redactedFieldIds).toEqual(["customer_note"]);
    expect(projection.diagnostics).toEqual([
      "view_hidden:salary",
      "view_redacted:customer_note"
    ]);
  });

  it("evaluates non-empty filters and ascending sort order deterministically", () => {
    const leftRow = [
      {
        fieldId: "lifecycle_state",
        fieldType: "status.semantic",
        value: "green"
      },
      {
        fieldId: "health_score",
        fieldType: "computed.readonly",
        value: "10"
      }
    ];
    const rightRow = [
      {
        fieldId: "lifecycle_state",
        fieldType: "status.semantic",
        value: null
      },
      {
        fieldId: "health_score",
        fieldType: "computed.readonly",
        value: "20"
      }
    ];
    const tieRow = [
      {
        fieldId: "lifecycle_state",
        fieldType: "status.semantic",
        value: "green"
      },
      {
        fieldId: "health_score",
        fieldType: "computed.readonly",
        value: "10"
      }
    ];

    expect(viewPlanner.rowMatchesFilters(leftRow, ["lifecycle_state"])).toBe(true);
    expect(viewPlanner.rowMatchesFilters(rightRow, ["lifecycle_state"])).toBe(false);
    expect(viewPlanner.compareRows(leftRow, rightRow, ["health_score"])).toBeLessThan(0);
    expect(viewPlanner.compareRows(leftRow, tieRow, ["health_score"])).toBe(0);
  });

  for (const fieldType of fieldTypeRegistry.list()) {
    it(`matches field view capabilities for ${fieldType.type}`, () => {
      expect(viewPlanner.describeField(fieldType.type)).toEqual({
        capabilities: fieldType.capabilities,
        supportedConditionOperators: fieldType.supportedConditionOperators,
        supportedSortModes: fieldType.supportedSortModes
      });
    });
  }
});
