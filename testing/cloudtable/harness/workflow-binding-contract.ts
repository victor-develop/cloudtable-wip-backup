import { createFieldTypeRegistry } from "../../../src/core/field-types/registry";
import {
  buildWorkflowAuthoringMetadata,
  type WorkflowBindingMetadataField
} from "../../../src/core/workflows/binding-metadata";
import type { JsonValue } from "../../../src/core/field-types/types";

const fieldTypeRegistry = createFieldTypeRegistry();

type JsonObject = Record<string, JsonValue>;
type WorkflowBindingContractField = Omit<WorkflowBindingMetadataField, "config"> & {
  config: JsonObject;
};

type WorkflowBindingFieldOverrides = Partial<WorkflowBindingContractField> & {
  config?: JsonObject;
};

function createWorkflowBindingField(
  field: WorkflowBindingContractField,
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return {
    ...field,
    ...overrides,
    config: overrides?.config ?? field.config
  };
}

export function createRowOwnerWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {
        rowOwner: true
      },
      fieldId: "fld_owner",
      fieldKey: "owner",
      fieldType: "principal.user"
    },
    overrides
  );
}

export function createAssigneeAliasWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {
        workflowBindingAlias: "row.assignee"
      },
      fieldId: "fld_assignee",
      fieldKey: "assignee",
      fieldType: "principal.user"
    },
    overrides
  );
}

export function createStatusWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
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
    },
    overrides
  );
}

export function createLongTextWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {},
      fieldId: "fld_note",
      fieldKey: "customer_note",
      fieldType: "text.long"
    },
    overrides
  );
}

export function createSingleSelectWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
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
    },
    overrides
  );
}

export function createCheckboxWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {},
      fieldId: "fld_verified",
      fieldKey: "is_verified",
      fieldType: "boolean.checkbox"
    },
    overrides
  );
}

export function createRelationWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {
        allowMultiple: true,
        targetTableId: "tbl_companies"
      },
      fieldId: "fld_related_companies",
      fieldKey: "related_companies",
      fieldType: "relation.record"
    },
    overrides
  );
}

export function createNumberWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {
        precision: 2
      },
      fieldId: "fld_amount",
      fieldKey: "deal_amount",
      fieldType: "number.decimal"
    },
    overrides
  );
}

export function createDateWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {},
      fieldId: "fld_due_date",
      fieldKey: "due_date",
      fieldType: "date.date"
    },
    overrides
  );
}

export function createTitleWorkflowBindingField(
  overrides?: WorkflowBindingFieldOverrides
): WorkflowBindingContractField {
  return createWorkflowBindingField(
    {
      config: {},
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line"
    },
    overrides
  );
}

export function buildWorkflowBindingContract(fields: readonly WorkflowBindingMetadataField[]) {
  return buildWorkflowAuthoringMetadata(fieldTypeRegistry, fields);
}
