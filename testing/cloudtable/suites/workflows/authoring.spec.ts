import { describe, expect, it } from "vitest";

import { createAggregateOperationRegistry } from "../../../../src/core/aggregates/registry";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import {
  buildWorkflowAuthoringMetadata,
  normalizeWorkflowAuthoringMetadata
} from "../../../../src/core/workflows/binding-metadata";
import {
  buildWorkflowRecipeAuthoringCatalog,
  draftWorkflowConditionsFromMetadata,
  inspectWorkflowConditionsFromMetadata
} from "../../../../src/core/workflows/authoring";
import { serializeWorkflowOperatorManifest } from "../../../../src/core/workflows/manifest";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import type { WorkflowConditionManifest } from "../../../../src/core/workflows/types";
import {
  buildWorkflowBindingContract,
  createAssigneeAliasWorkflowBindingField,
  createRelationWorkflowBindingField,
  createRowOwnerWorkflowBindingField
} from "../../harness/workflow-binding-contract";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();
const aggregateOperationRegistry = createAggregateOperationRegistry();

function supportedOperators(operatorIds: readonly string[]): WorkflowConditionManifest[] {
  return operatorIds.map(
    (operatorId) =>
      serializeWorkflowOperatorManifest(
        workflowOperatorRegistry.require(operatorId)
      ) as WorkflowConditionManifest
  );
}

describe("workflow authoring", () => {
  it("publishes the canonical direct-sync recipe authoring contract", () => {
    const catalog = buildWorkflowRecipeAuthoringCatalog({
      aggregateOperationRegistry,
      workflowOperatorRegistry
    });

    expect(catalog.recipeTypes).toEqual(["direct_sync", "grouped_rollup"]);
    expect(catalog.recipes.direct_sync).toMatchObject({
      fixedTriggerId: "field_changed",
      maintenance: {
        kinds: ["backfill", "recompute"],
        queuedMessage: "Sync maintenance is queued after publish and runs asynchronously.",
        route: {
          method: "POST",
          pathTemplate: "/v1/workflows/{workflowId}/sync-maintenance"
        }
      },
      matchStrategies: ["single_relation", "value_match"],
      previewRoute: {
        method: "POST",
        pathTemplate: "/v1/tables/{tableId}/workflow-recipes/preview"
      },
      publishRoute: {
        method: "POST",
        pathTemplate: "/v1/workflows/{workflowId}/publish"
      },
      recipeType: "direct_sync",
      requiredInputIds: [
        "tableId",
        "workflowId",
        "name",
        "syncSourceFieldId",
        "syncTargetFieldId",
        "relatedSourceFieldId"
      ],
      statusValues: ["draft", "published", "paused"]
    });
    expect(catalog.recipes.direct_sync.workflowOperators.map((operator) => operator.id)).toEqual([
      "sync_related_field"
    ]);
  });

  it("publishes the canonical grouped-rollup recipe authoring contract", () => {
    const catalog = buildWorkflowRecipeAuthoringCatalog({
      aggregateOperationRegistry,
      workflowOperatorRegistry
    });

    expect(catalog.recipes.grouped_rollup).toMatchObject({
      fixedTriggerId: "field_changed",
      maintenance: {
        kinds: ["backfill", "recompute"],
        queuedMessage: "Rollup maintenance is queued after publish and runs asynchronously.",
        route: {
          method: "POST",
          pathTemplate: "/v1/workflows/{workflowId}/aggregate-maintenance"
        }
      },
      matchStrategies: ["single_relation", "value_match"],
      previewRoute: {
        method: "POST",
        pathTemplate: "/v1/tables/{tableId}/workflow-recipes/preview"
      },
      publishRoute: {
        method: "POST",
        pathTemplate: "/v1/workflows/{workflowId}/publish"
      },
      recipeType: "grouped_rollup",
      requiredInputIds: ["tableId", "workflowId", "name", "rollupFieldIds"],
      statusValues: ["draft", "published", "paused"]
    });
    expect(catalog.recipes.grouped_rollup.workflowOperators.map((operator) => operator.id)).toEqual([
      "set_cell"
    ]);
    expect(catalog.recipes.grouped_rollup.aggregateOperations?.map((operation) => operation.id)).toEqual([
      "count_records",
      "sum_numbers",
      "max_number",
      "min_number",
      "average_numbers"
    ]);
  });

  it("publishes supported condition operator metadata alongside binding-local ids", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {},
        fieldId: "fld_note",
        fieldKey: "customer_note",
        fieldType: "text.long"
      }
    ]);

    expect(metadata.bindings["row.fields.customer_note"]).toMatchObject({
      supportedOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
      supportedOperators: supportedOperators([
        "equals",
        "not_equals",
        "is_empty",
        "is_not_empty"
      ])
    });
  });

  it("prefers the canonical row.owner binding when metadata hints would draft the same owner-assigned condition", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      createRowOwnerWorkflowBindingField()
    ]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when the owner is assigned.",
        fieldIds: ["fld_owner"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.owner.fieldId"
          },
          fieldType: {
            path: "row.owner.fieldType"
          },
          value: {
            path: "row.owner.value"
          }
        },
        operatorId: "is_not_empty"
      }
    ]);
  });

  it("drafts canonical row.owner comparisons from metadata-defined proposal templates", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      createRowOwnerWorkflowBindingField()
    ]);
    const expectedBindings = buildWorkflowBindingContract([
      createRowOwnerWorkflowBindingField()
    ]).bindings;

    expect(metadata.bindings["row.owner"]).toEqual(expectedBindings["row.owner"]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when the owner is assigned to a specific teammate.",
        fieldIds: ["fld_owner"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.owner.fieldId"
          },
          fieldType: {
            path: "row.owner.fieldType"
          },
          value: {
            path: "row.owner.value"
          },
          left: {
            path: "row.owner.value"
          },
          right: null
        },
        operatorId: "equals"
      }
    ]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when the owner is not assigned to the fallback user.",
        fieldIds: ["fld_owner"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.owner.fieldId"
          },
          fieldType: {
            path: "row.owner.fieldType"
          },
          value: {
            path: "row.owner.value"
          },
          left: {
            path: "row.owner.value"
          },
          right: null
        },
        operatorId: "not_equals"
      }
    ]);
  });

  it("emits canonical aliases from field metadata instead of a row-owner-only helper", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      createAssigneeAliasWorkflowBindingField()
    ]);
    const expectedBindings = buildWorkflowBindingContract([
      createAssigneeAliasWorkflowBindingField()
    ]).bindings;

    expect(metadata.bindings["row.assignee"]).toEqual(expectedBindings["row.assignee"]);
  });

  it("rejects conflicting canonical aliases before authoring metadata can collapse them", () => {
    expect(() =>
      buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
        {
          config: {
            workflowBindingAlias: "row.assignee"
          },
          fieldId: "fld_assignee_a",
          fieldKey: "assignee_a",
          fieldType: "principal.user"
        },
        {
          config: {
            workflowBindingAlias: "row.assignee"
          },
          fieldId: "fld_assignee_b",
          fieldKey: "assignee_b",
          fieldType: "principal.user"
        }
      ])
    ).toThrow("canonical_workflow_binding_alias_conflict:row.assignee:fld_assignee_a:fld_assignee_b");
  });

  it("drafts generic missing-field conditions from metadata-declared proposal hints", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {},
        fieldId: "fld_note",
        fieldKey: "customer_note",
        fieldType: "text.long"
      }
    ]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when the customer note is missing.",
        fieldIds: ["fld_note"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.customer_note.fieldId"
          },
          fieldType: {
            path: "row.fields.customer_note.fieldType"
          },
          value: {
            path: "row.fields.customer_note.value"
          }
        },
        operatorId: "is_empty"
      }
    ]);
  });

  it("drafts configured status option comparisons from metadata-declared proposal inputs", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {
          options: [
            { id: "open", label: "Open", semantic: "todo" },
            { id: "qualified", label: "Qualified", semantic: "done" }
          ]
        },
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic"
      }
    ]);

    expect(metadata.bindings["row.fields.status"]).toMatchObject({
      proposalHints: expect.arrayContaining([
        expect.objectContaining({
          operatorId: "equals",
          draftInput: {
            left: {
              path: "row.fields.status.value"
            },
            right: "qualified"
          }
        })
      ])
    });
    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when status changes to Qualified.",
        fieldIds: ["fld_status"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.status.fieldId"
          },
          fieldType: {
            path: "row.fields.status.fieldType"
          },
          value: {
            path: "row.fields.status.value"
          },
          left: {
            path: "row.fields.status.value"
          },
          right: "qualified"
        },
        operatorId: "equals"
      }
    ]);
  });

  it("drafts configured single-select option comparisons from metadata-declared proposal inputs", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {
          options: [
            { id: "lead", label: "Lead" },
            { id: "customer", label: "Customer" }
          ]
        },
        fieldId: "fld_stage",
        fieldKey: "lifecycle_stage",
        fieldType: "select.single"
      }
    ]);

    expect(metadata.bindings["row.fields.lifecycle_stage"]).toMatchObject({
      proposalHints: expect.arrayContaining([
        expect.objectContaining({
          operatorId: "equals",
          draftInput: {
            left: {
              path: "row.fields.lifecycle_stage.value"
            },
            right: "customer"
          }
        })
      ])
    });
    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when lifecycle stage changes to Customer.",
        fieldIds: ["fld_stage"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.lifecycle_stage.fieldId"
          },
          fieldType: {
            path: "row.fields.lifecycle_stage.fieldType"
          },
          value: {
            path: "row.fields.lifecycle_stage.value"
          },
          left: {
            path: "row.fields.lifecycle_stage.value"
          },
          right: "customer"
        },
        operatorId: "equals"
      }
    ]);
  });

  it("drafts configured multi-select option comparisons from metadata-declared proposal inputs", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {
          options: [
            { id: "vip", label: "VIP" },
            { id: "renewal", label: "Renewal" }
          ]
        },
        fieldId: "fld_segments",
        fieldKey: "segments",
        fieldType: "select.multi"
      }
    ]);

    expect(metadata.bindings["row.fields.segments"]).toMatchObject({
      proposalHints: expect.arrayContaining([
        expect.objectContaining({
          operatorId: "select_has_option",
          draftInput: {
            option: "renewal"
          }
        })
      ])
    });
    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when segments includes Renewal.",
        fieldIds: ["fld_segments"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.segments.fieldId"
          },
          fieldType: {
            path: "row.fields.segments.fieldType"
          },
          value: {
            path: "row.fields.segments.value"
          },
          option: "renewal"
        },
        operatorId: "select_has_option"
      }
    ]);
  });

  it("drafts checkbox equality conditions from metadata-defined proposal templates", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {},
        fieldId: "fld_verified",
        fieldKey: "is_verified",
        fieldType: "boolean.checkbox"
      }
    ]);

    expect(metadata.bindings["row.fields.is_verified"].proposalHints).toEqual(
      expect.arrayContaining([
        {
          operatorId: "equals",
          matchPhrases: ["is unchecked", "unchecked", "is not checked", "not checked", "is false"],
          matchFieldPhrases: [
            "{field} is unchecked",
            "{field} unchecked",
            "{field} is not checked",
            "{field} not checked",
            "{field} is false"
          ],
          draftInput: {
            left: {
              path: "row.fields.is_verified.value"
            },
            right: false
          }
        },
        {
          operatorId: "equals",
          matchPhrases: ["is checked", "checked", "is true"],
          matchFieldPhrases: [
            "{field} is checked",
            "{field} checked",
            "{field} is true"
          ],
          draftInput: {
            left: {
              path: "row.fields.is_verified.value"
            },
            right: true
          }
        }
      ])
    );

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify finance when is verified is checked.",
        fieldIds: ["fld_verified"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.is_verified.fieldId"
          },
          fieldType: {
            path: "row.fields.is_verified.fieldType"
          },
          value: {
            path: "row.fields.is_verified.value"
          },
          left: {
            path: "row.fields.is_verified.value"
          },
          right: true
        },
        operatorId: "equals"
      }
    ]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify finance when is verified is unchecked.",
        fieldIds: ["fld_verified"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.is_verified.fieldId"
          },
          fieldType: {
            path: "row.fields.is_verified.fieldType"
          },
          value: {
            path: "row.fields.is_verified.value"
          },
          left: {
            path: "row.fields.is_verified.value"
          },
          right: false
        },
        operatorId: "equals"
      }
    ]);
  });

  it("drafts relation contains-record conditions from metadata-defined proposal templates", () => {
    const relationField = createRelationWorkflowBindingField();
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [relationField]);

    expect(metadata.bindings["row.fields.related_companies"].proposalHints).toContainEqual({
      operatorId: "relation_contains_record",
      matchPhrases: ["contains", "includes", "linked to", "related to", "references"],
      matchFieldPhrases: [
        "{field} contains",
        "{field} includes",
        "{field} is linked to",
        "{field} linked to",
        "{field} is related to",
        "{field} related to",
        "{field} references"
      ],
      draftInput: {
        recordId: null,
        value: {
          path: "row.fields.related_companies.value"
        }
      }
    });

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when related companies includes the parent account.",
        fieldIds: [relationField.fieldId]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.related_companies.fieldId"
          },
          fieldType: {
            path: "row.fields.related_companies.fieldType"
          },
          value: {
            path: "row.fields.related_companies.value"
          },
          recordId: null
        },
        operatorId: "relation_contains_record"
      }
    ]);
  });

  it("drafts numeric comparison conditions from metadata-defined proposal templates", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {
          precision: 2
        },
        fieldId: "fld_amount",
        fieldKey: "deal_amount",
        fieldType: "number.decimal"
      },
      {
        config: {
          integerOnly: true
        },
        fieldId: "fld_seats",
        fieldKey: "seat_count",
        fieldType: "number.decimal"
      }
    ]);

    expect(metadata.bindings["row.fields.deal_amount"].proposalHints).toContainEqual({
      operatorId: "number_compare",
      matchPhrases: ["at least", "no less than", "greater than or equal to"],
      matchFieldPhrases: [
        "{field} at least",
        "{field} is at least",
        "{field} no less than"
      ],
      draftInput: {
        comparator: "gte",
        left: {
          path: "row.fields.deal_amount.value"
        },
        right: null
      }
    });

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Alert finance when deal amount is at least the approval floor.",
        fieldIds: ["fld_amount"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.deal_amount.fieldId"
          },
          fieldType: {
            path: "row.fields.deal_amount.fieldType"
          },
          value: {
            path: "row.fields.deal_amount.value"
          },
          comparator: "gte",
          left: {
            path: "row.fields.deal_amount.value"
          },
          right: null
        },
        operatorId: "number_compare"
      }
    ]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Escalate when seat count is more than the approved limit.",
        fieldIds: ["fld_seats"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.seat_count.fieldId"
          },
          fieldType: {
            path: "row.fields.seat_count.fieldType"
          },
          value: {
            path: "row.fields.seat_count.value"
          },
          comparator: "gt",
          left: {
            path: "row.fields.seat_count.value"
          },
          right: null
        },
        operatorId: "number_compare"
      }
    ]);

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Alert finance when deal amount is less than the cap.",
        fieldIds: ["fld_amount"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.deal_amount.fieldId"
          },
          fieldType: {
            path: "row.fields.deal_amount.fieldType"
          },
          value: {
            path: "row.fields.deal_amount.value"
          },
          comparator: "lt",
          left: {
            path: "row.fields.deal_amount.value"
          },
          right: null
        },
        operatorId: "number_compare"
      }
    ]);
  });

  it("drafts date comparison conditions from metadata-defined proposal templates", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {},
        fieldId: "fld_due_date",
        fieldKey: "due_date",
        fieldType: "date.date"
      }
    ]);
    const datetimeMetadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {},
        fieldId: "fld_review_timestamp",
        fieldKey: "review_timestamp",
        fieldType: "date.datetime"
      }
    ]);

    expect(metadata.bindings["row.fields.due_date"].proposalHints).toContainEqual({
      operatorId: "date_compare",
      matchPhrases: ["on or before", "no later than"],
      matchFieldPhrases: [
        "{field} on or before",
        "{field} is on or before",
        "{field} no later than"
      ],
      draftInput: {
        comparator: "on_or_before",
        left: {
          path: "row.fields.due_date.value"
        },
        right: null
      }
    });
    expect(datetimeMetadata.bindings["row.fields.review_timestamp"].proposalHints).toContainEqual({
      operatorId: "date_compare",
      matchPhrases: ["on or after", "no earlier than"],
      matchFieldPhrases: [
        "{field} on or after",
        "{field} is on or after",
        "{field} no earlier than"
      ],
      draftInput: {
        comparator: "on_or_after",
        left: {
          path: "row.fields.review_timestamp.value"
        },
        right: null
      }
    });

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Escalate when due date is on or before the contract deadline.",
        fieldIds: ["fld_due_date"]
      })
    ).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.due_date.fieldId"
          },
          fieldType: {
            path: "row.fields.due_date.fieldType"
          },
          value: {
            path: "row.fields.due_date.value"
          },
          comparator: "on_or_before",
          left: {
            path: "row.fields.due_date.value"
          },
          right: null
        },
        operatorId: "date_compare"
      }
    ]);
  });

  it("drafts operator-specific condition input from metadata templates without hard-coded field/value scaffolding", () => {
    const metadata = {
      bindings: {
        "row.fields.status": {
          binding: "row.fields.status",
          fieldId: "fld_status",
          fieldKey: "status",
          fieldType: "status.semantic",
          proposalHints: [
            {
              matchPhrases: ["status is qualified"],
              operatorId: "equals"
            }
          ],
          supportedOperatorIds: ["equals"],
          supportedOperators: supportedOperators(["equals"]),
          template: {
            input: {
              left: {
                path: "row.fields.status.value"
              },
              right: "qualified"
            }
          }
        }
      }
    };

    expect(
      draftWorkflowConditionsFromMetadata(metadata, {
        businessRule: "Notify sales ops when status is qualified.",
        fieldIds: ["fld_status"]
      })
    ).toEqual([
      {
        input: {
          left: {
            path: "row.fields.status.value"
          },
          right: "qualified"
        },
        operatorId: "equals"
      }
    ]);
  });

  it("inspects saved conditions through canonical binding and operator metadata", () => {
    const metadata = buildWorkflowAuthoringMetadata(fieldTypeRegistry, [
      {
        config: {
          rowOwner: true
        },
        fieldId: "fld_owner",
        fieldKey: "owner",
        fieldType: "principal.user"
      },
      {
        config: {},
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic"
      }
    ]);

    expect(
      inspectWorkflowConditionsFromMetadata(
        {
          actions: [],
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.owner.fieldId"
                },
                fieldType: {
                  path: "row.owner.fieldType"
                },
                value: {
                  path: "row.owner.value"
                }
              },
              operatorId: "is_not_empty"
            },
            {
              input: {
                fieldId: {
                  path: "row.fields.status.fieldId"
                },
                fieldType: {
                  path: "row.fields.status.fieldType"
                },
                left: {
                  path: "row.fields.status.value"
                },
                right: "qualified"
              },
              operatorId: "equals"
            }
          ],
          trigger: {
            operatorId: "record_updated"
          },
          workflowId: "wf_condition_metadata"
        },
        metadata,
        workflowOperatorRegistry
      )
    ).toEqual([
      {
        diagnostics: [],
        index: 0,
        operator: supportedOperators(["is_not_empty"])[0],
        operatorId: "is_not_empty",
        referencedBindingNames: ["row.owner"],
        resolvedBindings: [metadata.bindings["row.owner"]]
      },
      {
        diagnostics: [],
        index: 1,
        operator: supportedOperators(["equals"])[0],
        operatorId: "equals",
        referencedBindingNames: ["row.fields.status"],
        resolvedBindings: [metadata.bindings["row.fields.status"]]
      }
    ]);
  });

  it("resolves canonical aliases from binding metadata instead of hard-coded row.owner handling", () => {
    const metadata = {
      bindings: {
        "row.canonical.assignee": {
          aliasOf: "row.fields.assignee",
          binding: "row.canonical.assignee",
          fieldId: "fld_assignee",
          fieldKey: "assignee",
          fieldType: "principal.user",
          isCanonical: true,
          proposalHints: [],
          supportedOperatorIds: ["is_not_empty"],
          supportedOperators: supportedOperators(["is_not_empty"]),
          template: {
            fieldIdPath: "row.canonical.assignee.fieldId",
            fieldTypePath: "row.canonical.assignee.fieldType",
            valuePath: "row.canonical.assignee.value"
          }
        },
        "row.fields.assignee": {
          binding: "row.fields.assignee",
          fieldId: "fld_assignee",
          fieldKey: "assignee",
          fieldType: "principal.user",
          proposalHints: [],
          supportedOperatorIds: ["is_not_empty"],
          supportedOperators: supportedOperators(["is_not_empty"]),
          template: {
            fieldIdPath: "row.fields.assignee.fieldId",
            fieldTypePath: "row.fields.assignee.fieldType",
            valuePath: "row.fields.assignee.value"
          }
        }
      }
    };

    expect(
      inspectWorkflowConditionsFromMetadata(
        {
          actions: [],
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.canonical.assignee.fieldId"
                },
                fieldType: {
                  path: "row.canonical.assignee.fieldType"
                },
                value: {
                  path: "row.canonical.assignee.value"
                }
              },
              operatorId: "is_not_empty"
            }
          ],
          trigger: {
            operatorId: "record_updated"
          },
          workflowId: "wf_canonical_alias_metadata"
        },
        metadata,
        workflowOperatorRegistry
      )
    ).toEqual([
      {
        diagnostics: [],
        index: 0,
        operator: supportedOperators(["is_not_empty"])[0],
        operatorId: "is_not_empty",
        referencedBindingNames: ["row.canonical.assignee"],
        resolvedBindings: [metadata.bindings["row.canonical.assignee"]]
      }
    ]);
  });

  it("resolves referenced bindings from metadata-defined template input paths", () => {
    const metadata = {
      bindings: {
        "row.conditions.owner_assigned": {
          binding: "row.conditions.owner_assigned",
          fieldId: "fld_owner",
          fieldKey: "owner",
          fieldType: "principal.user",
          proposalHints: [],
          supportedOperatorIds: ["equals"],
          supportedOperators: supportedOperators(["equals"]),
          template: {
            input: {
              left: {
                path: "row.owner.value"
              },
              right: ["usr_owner"]
            }
          }
        }
      }
    };

    expect(
      inspectWorkflowConditionsFromMetadata(
        {
          actions: [],
          conditions: [
            {
              input: {
                left: {
                  path: "row.owner.value"
                },
                right: ["usr_owner"]
              },
              operatorId: "equals"
            }
          ],
          trigger: {
            operatorId: "record_updated"
          },
          workflowId: "wf_template_metadata_paths"
        },
        metadata,
        workflowOperatorRegistry
      )
    ).toEqual([
      {
        diagnostics: [],
        index: 0,
        operator: supportedOperators(["equals"])[0],
        operatorId: "equals",
        referencedBindingNames: ["row.conditions.owner_assigned"],
        resolvedBindings: [metadata.bindings["row.conditions.owner_assigned"]]
      }
    ]);
  });

  it("normalizes wrapped workflow metadata and filters malformed bindings", () => {
    expect(
      normalizeWorkflowAuthoringMetadata({
        workflow: {
          bindings: {
            "row.fields.customer_note": {
              binding: "row.fields.customer_note",
              fieldId: "fld_note",
              fieldKey: "customer_note",
              fieldType: "text.long",
              proposalHints: [
                {
                  operatorId: "equals",
                  matchPhrases: ["changes to qualified"],
                  draftInput: {
                    left: {
                      path: "row.fields.customer_note.value"
                    },
                    right: "qualified"
                  }
                },
                {
                  operatorId: "is_empty",
                  matchPhrases: ["missing"],
                  matchFieldPhrases: ["{field} missing"]
                }
              ],
              supportedOperatorIds: ["is_empty"],
              supportedOperators: supportedOperators(["is_empty"]),
              template: {
                fieldIdPath: "row.fields.customer_note.fieldId",
                fieldTypePath: "row.fields.customer_note.fieldType",
                input: {
                  value: {
                    path: "row.fields.customer_note.value"
                  }
                },
                valuePath: "row.fields.customer_note.value"
              }
            },
            "row.fields.invalid": {
              binding: "row.fields.invalid",
              fieldId: "fld_invalid"
            }
          }
        }
      })
    ).toEqual({
      bindings: {
        "row.fields.customer_note": {
          binding: "row.fields.customer_note",
          fieldId: "fld_note",
          fieldKey: "customer_note",
          fieldType: "text.long",
          proposalHints: [
            {
              operatorId: "equals",
              matchPhrases: ["changes to qualified"],
              draftInput: {
                left: {
                  path: "row.fields.customer_note.value"
                },
                right: "qualified"
              }
            },
            {
              operatorId: "is_empty",
              matchPhrases: ["missing"],
              matchFieldPhrases: ["{field} missing"]
            }
          ],
          supportedOperatorIds: ["is_empty"],
          supportedOperators: supportedOperators(["is_empty"]),
          template: {
            fieldIdPath: "row.fields.customer_note.fieldId",
            fieldTypePath: "row.fields.customer_note.fieldType",
            input: {
              value: {
                path: "row.fields.customer_note.value"
              }
            },
            valuePath: "row.fields.customer_note.value"
          }
        }
      }
    });
  });
});
