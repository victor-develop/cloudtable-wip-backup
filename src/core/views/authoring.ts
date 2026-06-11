import type { FieldTypeCapabilities } from "../field-types/types";
import { serializeWorkflowOperatorManifest } from "../workflows/manifest";
import type {
  WorkflowConditionManifest,
  WorkflowOperatorRegistry
} from "../workflows/types";
import type { ViewPlanner } from "./planner";

export type ViewAuthoringFieldMetadata = {
  capabilities: {
    supportsFiltering: boolean;
    supportsGrouping: boolean;
    supportsSorting: boolean;
  };
  fieldId: string;
  fieldKey: string;
  fieldType: string;
  supportedFilterOperatorIds: string[];
  supportedFilterOperators: WorkflowConditionManifest[];
  supportedSortModes: string[];
};

export type ViewAuthoringMetadata = {
  fieldIds: string[];
  fields: Record<string, ViewAuthoringFieldMetadata>;
  filterableFieldIds: string[];
  groupableFieldIds: string[];
  sortableFieldIds: string[];
};

type ViewAuthoringFieldSource = {
  fieldId: string;
  fieldKey: string;
  fieldType: string;
};

function pickViewCapabilities(capabilities: FieldTypeCapabilities) {
  return {
    supportsFiltering: capabilities.supportsFiltering,
    supportsGrouping: capabilities.supportsGrouping,
    supportsSorting: capabilities.supportsSorting
  };
}

export function buildViewAuthoringMetadata<T>(
  viewPlanner: ViewPlanner,
  fields: readonly T[],
  selectField: (field: T) => ViewAuthoringFieldSource,
  workflowOperatorRegistry?: WorkflowOperatorRegistry
): ViewAuthoringMetadata {
  const metadataFields: Array<[string, ViewAuthoringFieldMetadata]> = [];

  for (const field of fields) {
    const selected = selectField(field);
    const description = viewPlanner.describeField(selected.fieldType);
    const supportedFilterOperatorIds = [...description.supportedConditionOperators];
    const supportedFilterOperators =
      workflowOperatorRegistry == null
        ? []
        : supportedFilterOperatorIds.map((operatorId) => {
            const operator = workflowOperatorRegistry.require(operatorId);
            if (operator.kind !== "condition") {
              throw new Error(
                `View field ${selected.fieldId} references non-condition operator: ${operatorId}`
              );
            }

            return serializeWorkflowOperatorManifest(operator) as WorkflowConditionManifest;
          });

    metadataFields.push([
      selected.fieldId,
      {
        capabilities: pickViewCapabilities(description.capabilities),
        fieldId: selected.fieldId,
        fieldKey: selected.fieldKey,
        fieldType: selected.fieldType,
        supportedFilterOperatorIds,
        supportedFilterOperators,
        supportedSortModes: [...description.supportedSortModes]
      }
    ]);
  }

  const values = metadataFields.map(([, metadata]) => metadata);

  return {
    fieldIds: values.map((metadata) => metadata.fieldId),
    fields: Object.fromEntries(metadataFields),
    filterableFieldIds: values
      .filter((metadata) => metadata.capabilities.supportsFiltering)
      .map((metadata) => metadata.fieldId),
    groupableFieldIds: values
      .filter((metadata) => metadata.capabilities.supportsGrouping)
      .map((metadata) => metadata.fieldId),
    sortableFieldIds: values
      .filter((metadata) => metadata.capabilities.supportsSorting)
      .map((metadata) => metadata.fieldId)
  };
}
