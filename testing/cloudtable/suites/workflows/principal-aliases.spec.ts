import { describe, expect, it } from "vitest";

import {
  listCanonicalWorkflowBindingAliases,
  listPrincipalUserCanonicalBindings
} from "../../../../src/core/ownership/row-owner";
import {
  createAssigneeAliasWorkflowBindingField,
  createRowOwnerWorkflowBindingField
} from "../../harness/workflow-binding-contract";

describe("principal workflow aliases", () => {
  it("lists canonical principal bindings from principal.user field config", () => {
    expect(
      listPrincipalUserCanonicalBindings({
        rowOwner: true,
        workflowBindingAlias: "row.assignee"
      })
    ).toEqual([
      {
        binding: "row.owner",
        isCanonical: true
      },
      {
        binding: "row.assignee",
        isCanonical: true
      }
    ]);
  });

  it("surfaces field-declared canonical aliases alongside row.owner across fields", () => {
    const ownerField = createRowOwnerWorkflowBindingField();
    const assigneeField = createAssigneeAliasWorkflowBindingField();

    expect(
      listCanonicalWorkflowBindingAliases([
        ownerField,
        assigneeField,
        {
          config: {},
          fieldId: "fld_title",
          fieldKey: "title",
          fieldType: "text.single_line"
        }
      ])
    ).toEqual([
      {
        aliasOf: "row.fields.assignee",
        binding: "row.assignee",
        field: {
          config: assigneeField.config,
          fieldId: assigneeField.fieldId,
          fieldKey: assigneeField.fieldKey,
          fieldType: assigneeField.fieldType
        },
        isCanonical: true
      },
      {
        aliasOf: "row.fields.owner",
        binding: "row.owner",
        field: {
          config: ownerField.config,
          fieldId: ownerField.fieldId,
          fieldKey: ownerField.fieldKey,
          fieldType: ownerField.fieldType
        },
        isCanonical: true
      }
    ]);
  });

  it("rejects conflicting canonical aliases instead of silently deduplicating them", () => {
    expect(() =>
      listCanonicalWorkflowBindingAliases([
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
});
