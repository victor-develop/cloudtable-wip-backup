import { describe, expect, it } from "vitest";

import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import {
  buildWorkflowAuthoringMetadata,
  normalizeWorkflowAuthoringMetadata
} from "../../../../src/core/workflows/binding-metadata";
import { draftWorkflowConditionsFromMetadata } from "../../../../src/core/workflows/authoring";
import { serializeWorkflowOperatorManifest } from "../../../../src/core/workflows/manifest";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

function supportedOperators(operatorIds: readonly string[]) {
  return operatorIds.map((operatorId) =>
    serializeWorkflowOperatorManifest(workflowOperatorRegistry.require(operatorId))
  );
}

describe("workflow authoring", () => {
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
      {
        config: {
          rowOwner: true
        },
        fieldId: "fld_owner",
        fieldKey: "owner",
        fieldType: "principal.user"
      }
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
            valuePath: "row.fields.customer_note.value"
          }
        }
      }
    });
  });
});
