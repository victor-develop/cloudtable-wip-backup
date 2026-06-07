import type { FieldTypeRegistry } from "../field-types/types";
import type {
  EffectivePermissionSnapshot,
  PermissionEngine,
  PermissionFieldDescriptor,
  PermissionProjection,
  PermissionProjectionInput
} from "../permissions/types";

export type ViewQueryField = PermissionFieldDescriptor;

export type ViewQueryConstraint = PermissionFieldDescriptor & {
  kind: "filter" | "sort" | "group";
};

export type ViewQueryPlan = {
  allowed: boolean;
  blockedFieldIds: string[];
  diagnostics: string[];
  filterableFieldIds: string[];
  groupableFieldIds: string[];
  hiddenFieldIds: string[];
  redactedFieldIds: string[];
  redactionApplied: boolean;
  sortableFieldIds: string[];
  visibleFieldIds: string[];
};

function viewVisibilityDiagnostics(
  readState: "visible" | "redacted" | "hidden",
  fieldId: string
): string[] {
  if (readState === "hidden") {
    return [`view_hidden:${fieldId}`];
  }

  if (readState === "redacted") {
    return [`view_redacted:${fieldId}`];
  }

  return [];
}

function normalizeViewProjectionDiagnostics(diagnostics: readonly string[]): string[] {
  return Array.from(
    new Set(
      diagnostics.flatMap((diagnostic) => {
        if (diagnostic.startsWith("field_hidden:")) {
          return diagnostic.replace("field_hidden:", "view_hidden:");
        }

        if (diagnostic.startsWith("field_redacted:")) {
          return diagnostic.replace("field_redacted:", "view_redacted:");
        }

        if (diagnostic.startsWith("field_read_only:")) {
          return [];
        }

        return diagnostic;
      })
    )
  );
}

export type ViewPlanner = {
  describe(): {
    consistencyModel: "direct_record_strong" | "view_eventual";
    dependsOn: string[];
  };
  describeField(fieldType: string): {
    capabilities: ReturnType<FieldTypeRegistry["require"]>["capabilities"];
    supportedConditionOperators: readonly string[];
    supportedSortModes: readonly string[];
  };
  planQuery(
    fields: readonly ViewQueryField[],
    constraints?: readonly ViewQueryConstraint[],
    snapshot?: EffectivePermissionSnapshot
  ): ViewQueryPlan;
  projectRow(
    fields: readonly PermissionProjectionInput[],
    snapshot?: EffectivePermissionSnapshot
  ): PermissionProjection;
  rowMatchesFilters(
    fields: readonly PermissionProjectionInput[],
    filterFieldIds: readonly string[]
  ): boolean;
  compareRows(
    left: readonly PermissionProjectionInput[],
    right: readonly PermissionProjectionInput[],
    sortFieldIds: readonly string[]
  ): number;
};

function isEmptyProjectionValue(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function compareScalarValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    if (left === right) {
      return 0;
    }

    return left ? 1 : -1;
  }

  const leftText = String(left).toLowerCase();
  const rightText = String(right).toLowerCase();
  if (leftText === rightText) {
    const leftStable = String(left);
    const rightStable = String(right);
    return leftStable === rightStable ? 0 : leftStable < rightStable ? -1 : 1;
  }

  return leftText < rightText ? -1 : 1;
}

export function createViewPlanner(
  fieldTypeRegistry: FieldTypeRegistry,
  permissionEngine: PermissionEngine
): ViewPlanner {
  return {
    describe() {
      return {
        consistencyModel: "view_eventual",
        dependsOn: ["record_projection", "field_index_entries", "permission_engine"]
      };
    },
    describeField(fieldType) {
      const definition = fieldTypeRegistry.require(fieldType);

      return {
        capabilities: definition.capabilities,
        supportedConditionOperators: definition.getSupportedConditionOperators({
          fieldType
        }),
        supportedSortModes: definition.getSupportedSortModes({
          fieldType
        })
      };
    },
    planQuery(fields, constraints = [], snapshot) {
      const visibleFieldIds: string[] = [];
      const hiddenFieldIds: string[] = [];
      const redactedFieldIds: string[] = [];
      const filterableFieldIds: string[] = [];
      const sortableFieldIds: string[] = [];
      const groupableFieldIds: string[] = [];
      const blockedFieldIds = new Set<string>();
      const diagnostics = new Set<string>();
      const fieldAccess = new Map<
        string,
        {
          readState: "visible" | "redacted" | "hidden";
          supportsFiltering: boolean;
          supportsSorting: boolean;
          supportsGrouping: boolean;
        }
      >();

      for (const field of fields) {
        const definition = fieldTypeRegistry.require(field.fieldType);
        const access = permissionEngine.evaluateFieldAccess(
          field,
          "view-query",
          snapshot
        );

        fieldAccess.set(field.fieldId, {
          readState: access.readState,
          supportsFiltering: definition.capabilities.supportsFiltering,
          supportsSorting: definition.capabilities.supportsSorting,
          supportsGrouping: definition.capabilities.supportsGrouping
        });

        if (access.readState === "hidden") {
          hiddenFieldIds.push(field.fieldId);
          viewVisibilityDiagnostics(access.readState, field.fieldId).forEach((reason) =>
            diagnostics.add(reason)
          );
          continue;
        }

        visibleFieldIds.push(field.fieldId);

        if (access.readState === "redacted") {
          redactedFieldIds.push(field.fieldId);
          viewVisibilityDiagnostics(access.readState, field.fieldId).forEach((reason) =>
            diagnostics.add(reason)
          );
          continue;
        }

        if (definition.capabilities.supportsFiltering) {
          filterableFieldIds.push(field.fieldId);
        }

        if (definition.capabilities.supportsSorting) {
          sortableFieldIds.push(field.fieldId);
        }

        if (definition.capabilities.supportsGrouping) {
          groupableFieldIds.push(field.fieldId);
        }
      }

      for (const constraint of constraints) {
        const access = fieldAccess.get(constraint.fieldId);
        if (!access) {
          blockedFieldIds.add(constraint.fieldId);
          diagnostics.add(`view_unknown_field:${constraint.fieldId}`);
          continue;
        }

        if (access.readState !== "visible") {
          blockedFieldIds.add(constraint.fieldId);
          diagnostics.add(`view_constraint_hidden:${constraint.fieldId}`);
          continue;
        }

        if (constraint.kind === "filter" && !access.supportsFiltering) {
          blockedFieldIds.add(constraint.fieldId);
          diagnostics.add(`view_filter_unsupported:${constraint.fieldId}`);
        }

        if (constraint.kind === "sort" && !access.supportsSorting) {
          blockedFieldIds.add(constraint.fieldId);
          diagnostics.add(`view_sort_unsupported:${constraint.fieldId}`);
        }

        if (constraint.kind === "group" && !access.supportsGrouping) {
          blockedFieldIds.add(constraint.fieldId);
          diagnostics.add(`view_group_unsupported:${constraint.fieldId}`);
        }
      }

      return {
        allowed: blockedFieldIds.size === 0,
        blockedFieldIds: Array.from(blockedFieldIds),
        diagnostics: Array.from(diagnostics),
        filterableFieldIds,
        groupableFieldIds,
        hiddenFieldIds,
        redactedFieldIds,
        redactionApplied: redactedFieldIds.length > 0,
        sortableFieldIds,
        visibleFieldIds
      };
    },
    projectRow(fields, snapshot) {
      const projection = permissionEngine.projectFields(fields, "view-query", snapshot);

      return {
        ...projection,
        diagnostics: normalizeViewProjectionDiagnostics(projection.diagnostics)
      };
    },
    rowMatchesFilters(fields, filterFieldIds) {
      const fieldIndex = new Map(fields.map((field) => [field.fieldId, field]));

      return filterFieldIds.every((fieldId) => {
        const field = fieldIndex.get(fieldId);
        if (!field) {
          return false;
        }

        const definition = fieldTypeRegistry.require(field.fieldType);
        const normalized = definition.normalize(field.value, {
          fieldConfig: field.fieldConfig,
          fieldType: field.fieldType
        }).value;

        return !isEmptyProjectionValue(normalized?.raw ?? null);
      });
    },
    compareRows(left, right, sortFieldIds) {
      const leftIndex = new Map(left.map((field) => [field.fieldId, field]));
      const rightIndex = new Map(right.map((field) => [field.fieldId, field]));

      for (const fieldId of sortFieldIds) {
        const leftField = leftIndex.get(fieldId);
        const rightField = rightIndex.get(fieldId);
        if (!leftField || !rightField) {
          continue;
        }

        const definition = fieldTypeRegistry.require(leftField.fieldType);
        const leftNormalized = definition.normalize(leftField.value, {
          fieldConfig: leftField.fieldConfig,
          fieldType: leftField.fieldType
        }).value;
        const rightNormalized = definition.normalize(rightField.value, {
          fieldConfig: rightField.fieldConfig,
          fieldType: rightField.fieldType
        }).value;
        const leftIndexValue = definition.toIndex(leftNormalized, {
          fieldConfig: leftField.fieldConfig,
          fieldType: leftField.fieldType
        });
        const rightIndexValue = definition.toIndex(rightNormalized, {
          fieldConfig: rightField.fieldConfig,
          fieldType: rightField.fieldType
        });
        const leftComparable =
          leftIndexValue.numberValue != null
            ? Number(leftIndexValue.numberValue)
            : leftIndexValue.boolValue != null
              ? leftIndexValue.boolValue
              : leftIndexValue.datetimeValue ??
                leftIndexValue.referenceValue ??
                leftIndexValue.textValue ??
                leftIndexValue.displayValue;
        const rightComparable =
          rightIndexValue.numberValue != null
            ? Number(rightIndexValue.numberValue)
            : rightIndexValue.boolValue != null
              ? rightIndexValue.boolValue
              : rightIndexValue.datetimeValue ??
                rightIndexValue.referenceValue ??
                rightIndexValue.textValue ??
                rightIndexValue.displayValue;
        const leftEmpty = isEmptyProjectionValue(leftNormalized?.raw ?? null);
        const rightEmpty = isEmptyProjectionValue(rightNormalized?.raw ?? null);

        if (leftEmpty || rightEmpty) {
          if (leftEmpty && rightEmpty) {
            continue;
          }

          return leftEmpty ? 1 : -1;
        }

        const comparison = compareScalarValues(leftComparable, rightComparable);
        if (comparison !== 0) {
          return comparison;
        }
      }

      return 0;
    }
  };
}
