import type { FieldTypeRegistry } from "../field-types/types";
import type { WorkflowOperatorRegistry } from "../workflows/types";
import type { CommandEnvelope } from "./types";

type AggregateDescriptor = {
  id: string;
  type: "base" | "table" | "field" | "record" | "cell" | "view" | "workflow";
};

const SUPPORTED_DOMAIN_COMMAND_SPECS = {
  "base.create": {
    eventType: "base.created",
    fanoutReason: "base_created_fanout"
  },
  "table.create": {
    eventType: "table.created",
    fanoutReason: "table_created_fanout"
  },
  "field.create": {
    eventType: "field.created",
    fanoutReason: "field_created_fanout"
  },
  "field.update": {
    eventType: "field.updated",
    fanoutReason: "field_updated_fanout"
  },
  "field.permission.configure": {
    eventType: "field.permission.configured",
    fanoutReason: "field_permission_configured_fanout"
  },
  "view.create": {
    eventType: "view.created",
    fanoutReason: "view_created_fanout"
  },
  "view.update": {
    eventType: "view.updated",
    fanoutReason: "view_updated_fanout"
  },
  "workflow.create": {
    eventType: "workflow.created",
    fanoutReason: "workflow_created_fanout"
  },
  "workflow.publish": {
    eventType: "workflow.published",
    fanoutReason: "workflow_published_fanout"
  },
  "workflow.pause": {
    eventType: "workflow.paused",
    fanoutReason: "workflow_paused_fanout"
  },
  "workflow.manual": {
    eventType: "workflow.manual",
    fanoutReason: "workflow_manual_fanout"
  },
  "workflow.webhook.enqueue": {
    eventType: "workflow.webhook.enqueued",
    fanoutReason: "workflow_webhook_enqueued"
  },
  "record.create": {
    eventType: "record.created",
    fanoutReason: "record_created_fanout"
  },
  "record.update": {
    eventType: "record.updated",
    fanoutReason: "record_updated_fanout"
  },
  "record.archive": {
    eventType: "record.archived",
    fanoutReason: "record_archived_fanout"
  },
  "cell.set": {
    eventType: "cell.set",
    fanoutReason: "cell_set_fanout"
  }
} as const satisfies Record<string, { eventType: string; fanoutReason: string }>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isSupportedDomainCommandType(commandType: string): boolean {
  return commandType in SUPPORTED_DOMAIN_COMMAND_SPECS;
}

function requireSupportedDomainCommandSpec(commandType: string) {
  const spec = SUPPORTED_DOMAIN_COMMAND_SPECS[commandType as keyof typeof SUPPORTED_DOMAIN_COMMAND_SPECS];
  if (!spec) {
    throw new Error(`Unsupported CloudTable command type: ${commandType}`);
  }

  return spec;
}

export function aggregateDescriptorForCommand(
  command: CommandEnvelope
): AggregateDescriptor | null {
  switch (command.commandType) {
    case "base.create": {
      const baseId = asString(command.payload.baseId);
      return baseId ? { id: baseId, type: "base" } : null;
    }
    case "table.create": {
      const tableId = asString(command.payload.tableId);
      return tableId ? { id: tableId, type: "table" } : null;
    }
    case "field.create":
    case "field.update": {
      const fieldId = asString(command.payload.fieldId);
      return fieldId ? { id: fieldId, type: "field" } : null;
    }
    case "field.permission.configure": {
      const fieldId = asString(command.payload.fieldId);
      return fieldId ? { id: fieldId, type: "field" } : null;
    }
    case "record.create": {
      return null;
    }
    case "record.update":
    case "record.archive": {
      const recordId = asString(command.payload.recordId);
      return recordId ? { id: recordId, type: "record" } : null;
    }
    case "view.create":
    case "view.update": {
      const viewId = asString(command.payload.viewId);
      return viewId ? { id: viewId, type: "view" } : null;
    }
    case "workflow.create":
    case "workflow.publish":
    case "workflow.pause":
    case "workflow.manual":
    case "workflow.webhook.enqueue": {
      const workflowId = asString(command.payload.workflowId);
      return workflowId ? { id: workflowId, type: "workflow" } : null;
    }
    case "cell.set": {
      const recordId = asString(command.payload.recordId);
      const fieldId = asString(command.payload.fieldId);
      return recordId && fieldId
        ? {
            id: `${recordId}:${fieldId}`,
            type: "cell"
          }
        : null;
    }
    default:
      return null;
  }
}

export function eventTypeForCommand(command: CommandEnvelope): string {
  return requireSupportedDomainCommandSpec(command.commandType).eventType;
}

export function fanoutReasonForCommand(command: CommandEnvelope): string {
  return requireSupportedDomainCommandSpec(command.commandType).fanoutReason;
}

export function validateDomainCommand(
  command: CommandEnvelope,
  fieldTypeRegistry: FieldTypeRegistry,
  workflowOperatorRegistry: WorkflowOperatorRegistry
): string[] {
  if (!isSupportedDomainCommandType(command.commandType)) {
    return [`unsupported_command_type:${command.commandType}`];
  }

  const diagnostics: string[] = [];
  const payload = command.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return diagnostics;
  }

  const requireString = (key: string) => {
    if (typeof payload[key] !== "string" || (payload[key] as string).length === 0) {
      diagnostics.push(`missing_payload_${key}`);
    }
  };

  switch (command.commandType) {
    case "base.create":
      requireString("baseId");
      requireString("slug");
      requireString("name");
      if (command.scope !== "workspace") {
        diagnostics.push("invalid_scope_for_base_create");
      }
      break;
    case "table.create":
      requireString("baseId");
      requireString("tableId");
      requireString("slug");
      requireString("name");
      if (command.scope !== "workspace") {
        diagnostics.push("invalid_scope_for_table_create");
      }
      break;
    case "field.create":
    case "field.update":
      requireString("fieldId");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (command.commandType === "field.create") {
        requireString("fieldKey");
        requireString("label");
        requireString("fieldType");
      }

      if (command.commandType === "field.update" && payload.config === undefined) {
        diagnostics.push("missing_payload_config");
      }

      const configuredFieldType =
        typeof payload.fieldType === "string" ? (payload.fieldType as string) : null;
      if (configuredFieldType && !fieldTypeRegistry.has(configuredFieldType)) {
        diagnostics.push(`unknown_field_type:${configuredFieldType}`);
      } else if (configuredFieldType) {
        const definition = fieldTypeRegistry.require(configuredFieldType);
        const configValidation = definition.validateConfig(payload.config ?? {}, {
          fieldType: configuredFieldType
        });
        diagnostics.push(
          ...configValidation.errors.map(
            (error) => `invalid_field_config:${configuredFieldType}:${error}`
          )
        );
      }
      if (command.scope !== "workspace") {
        diagnostics.push(
          command.commandType === "field.create"
            ? "invalid_scope_for_field_create"
            : "invalid_scope_for_field_update"
        );
      }
      break;
    case "field.permission.configure": {
      requireString("fieldId");
      requireString("principalId");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (typeof payload.policy !== "object" || payload.policy === null || Array.isArray(payload.policy)) {
        diagnostics.push("payload_policy_must_be_object");
        break;
      }

      const policy = payload.policy as Record<string, unknown>;
      if (!["visible", "redacted", "hidden"].includes(String(policy.read ?? ""))) {
        diagnostics.push("payload_policy_read_invalid");
      }
      for (const key of ["write", "workflow", "agent"] as const) {
        if (typeof policy[key] !== "boolean") {
          diagnostics.push(`payload_policy_${key}_must_be_boolean`);
        }
      }
      if (command.scope !== "workspace") {
        diagnostics.push("invalid_scope_for_field_permission_configure");
      }
      break;
    }
    case "record.create":
      requireString("recordId");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (
        payload.cells !== undefined &&
        (typeof payload.cells !== "object" ||
          payload.cells === null ||
          Array.isArray(payload.cells))
      ) {
        diagnostics.push("payload_cells_must_be_object");
      }
      if (command.scope !== "table") {
        diagnostics.push("invalid_scope_for_record_create");
      }
      break;
    case "view.create":
    case "view.update":
      requireString("viewId");
      requireString("viewName");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (
        payload.visibleFieldIds !== undefined &&
        (!Array.isArray(payload.visibleFieldIds) ||
          payload.visibleFieldIds.some((fieldId) => typeof fieldId !== "string"))
      ) {
        diagnostics.push("payload_visibleFieldIds_must_be_string_array");
      }
      if (
        payload.filterFieldIds !== undefined &&
        (!Array.isArray(payload.filterFieldIds) ||
          payload.filterFieldIds.some((fieldId) => typeof fieldId !== "string"))
      ) {
        diagnostics.push("payload_filterFieldIds_must_be_string_array");
      }
      if (
        payload.sortFieldIds !== undefined &&
        (!Array.isArray(payload.sortFieldIds) ||
          payload.sortFieldIds.some((fieldId) => typeof fieldId !== "string"))
      ) {
        diagnostics.push("payload_sortFieldIds_must_be_string_array");
      }
      if (
        payload.filters !== undefined &&
        (!Array.isArray(payload.filters) ||
          payload.filters.some(
            (filter) =>
              typeof filter !== "object" ||
              filter === null ||
              Array.isArray(filter) ||
              typeof (filter as Record<string, unknown>).fieldId !== "string" ||
              typeof (filter as Record<string, unknown>).operatorId !== "string" ||
              ("comparator" in (filter as Record<string, unknown>) &&
                (filter as Record<string, unknown>).comparator !== undefined &&
                typeof (filter as Record<string, unknown>).comparator !== "string")
          ))
      ) {
        diagnostics.push("payload_filters_must_be_filter_definition_array");
      }
      if (
        payload.sorts !== undefined &&
        (!Array.isArray(payload.sorts) ||
          payload.sorts.some(
            (sort) =>
              typeof sort !== "object" ||
              sort === null ||
              Array.isArray(sort) ||
              typeof (sort as Record<string, unknown>).fieldId !== "string" ||
              ("mode" in (sort as Record<string, unknown>) &&
                (sort as Record<string, unknown>).mode !== undefined &&
                typeof (sort as Record<string, unknown>).mode !== "string")
          ))
      ) {
        diagnostics.push("payload_sorts_must_be_sort_definition_array");
      }
      if (
        payload.groupByFieldId !== undefined &&
        payload.groupByFieldId !== null &&
        typeof payload.groupByFieldId !== "string"
      ) {
        diagnostics.push("payload_groupByFieldId_must_be_string_or_null");
      }
      if (command.scope !== "workspace") {
        diagnostics.push(
          command.commandType === "view.create"
            ? "invalid_scope_for_view_create"
            : "invalid_scope_for_view_update"
        );
      }
      break;
    case "workflow.create": {
      requireString("workflowId");
      requireString("workflowKey");
      requireString("name");
      if (
        typeof payload.definition !== "object" ||
        payload.definition === null ||
        Array.isArray(payload.definition)
      ) {
        diagnostics.push("payload_definition_must_be_object");
        break;
      }

      const definition = payload.definition as Record<string, unknown>;
      if (
        typeof definition.workflowId === "string" &&
        definition.workflowId !== payload.workflowId
      ) {
        diagnostics.push("workflow_definition_id_mismatch");
      }

      diagnostics.push(
        ...validateWorkflowDefinition(definition, workflowOperatorRegistry, {
          allowEmptyActionInputs: true,
          requirePublishableActions: false
        })
      );

      if (command.scope !== "workflow") {
        diagnostics.push("invalid_scope_for_workflow_create");
      }
      break;
    }
    case "workflow.publish":
    case "workflow.pause":
      requireString("workflowId");
      if (command.scope !== "workflow") {
        diagnostics.push(
          command.commandType === "workflow.publish"
            ? "invalid_scope_for_workflow_publish"
            : "invalid_scope_for_workflow_pause"
        );
      }
      break;
    case "workflow.manual":
      requireString("workflowId");
      if (
        payload.manualInvocationId !== undefined &&
        (typeof payload.manualInvocationId !== "string" ||
          (payload.manualInvocationId as string).length === 0)
      ) {
        diagnostics.push("payload_manualInvocationId_must_be_non_empty_string");
      }
      if (
        payload.input !== undefined &&
        (typeof payload.input !== "object" || payload.input === null || Array.isArray(payload.input))
      ) {
        diagnostics.push("payload_input_must_be_object");
      }
      if (command.scope !== "workflow") {
        diagnostics.push("invalid_scope_for_workflow_manual");
      }
      break;
    case "workflow.webhook.enqueue":
      requireString("workflowId");
      requireString("workflowRunId");
      requireString("workflowStepId");
      requireString("triggerEventId");
      requireString("destination");
      if (!Object.prototype.hasOwnProperty.call(payload, "body")) {
        diagnostics.push("missing_payload_body");
      }
      if (
        payload.method !== undefined &&
        (typeof payload.method !== "string" || (payload.method as string).length === 0)
      ) {
        diagnostics.push("payload_method_must_be_non_empty_string");
      }
      if (
        payload.headers !== undefined &&
        (typeof payload.headers !== "object" || payload.headers === null || Array.isArray(payload.headers))
      ) {
        diagnostics.push("payload_headers_must_be_object");
      }
      if (command.scope !== "workflow") {
        diagnostics.push("invalid_scope_for_workflow_webhook_enqueue");
      }
      break;
    case "record.update":
      requireString("recordId");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (
        typeof payload.patch !== "object" ||
        payload.patch === null ||
        Array.isArray(payload.patch)
      ) {
        diagnostics.push("payload_patch_must_be_object");
      }
      if (command.scope !== "table") {
        diagnostics.push("invalid_scope_for_record_update");
      }
      break;
    case "record.archive":
      requireString("recordId");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (command.scope !== "table") {
        diagnostics.push("invalid_scope_for_record_archive");
      }
      break;
    case "cell.set":
      requireString("recordId");
      requireString("fieldId");
      if (typeof command.tableId !== "string" || command.tableId.length === 0) {
        diagnostics.push("missing_tableId");
      }
      if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
        diagnostics.push("missing_payload_value");
      }
      if (command.scope !== "table") {
        diagnostics.push("invalid_scope_for_cell_set");
      }
      break;
  }

  return diagnostics;
}

function validateWorkflowDefinition(
  definition: Record<string, unknown>,
  workflowOperatorRegistry: WorkflowOperatorRegistry,
  options: {
    allowEmptyActionInputs: boolean;
    requirePublishableActions: boolean;
  }
): string[] {
  const diagnostics: string[] = [];
  const trigger =
    typeof definition.trigger === "object" &&
    definition.trigger !== null &&
    !Array.isArray(definition.trigger)
      ? (definition.trigger as Record<string, unknown>)
      : null;
  if (!trigger) {
    diagnostics.push("workflow_trigger_missing");
  } else {
    const triggerId = typeof trigger.operatorId === "string" ? trigger.operatorId : null;
    if (!triggerId) {
      diagnostics.push("workflow_trigger_operator_missing");
    } else {
      const operator = workflowOperatorRegistry.get(triggerId);
      if (!operator) {
        diagnostics.push(`workflow_trigger_unknown:${triggerId}`);
      } else if (operator.kind !== "trigger") {
        diagnostics.push(`workflow_trigger_wrong_kind:${triggerId}`);
      }
    }
  }

  const conditions = Array.isArray(definition.conditions) ? definition.conditions : [];
  for (const [index, entry] of conditions.entries()) {
    if (!isRecord(entry)) {
      diagnostics.push(`workflow_condition_invalid:${index}`);
      continue;
    }

    const operatorId = typeof entry.operatorId === "string" ? entry.operatorId : null;
    if (!operatorId) {
      diagnostics.push(`workflow_condition_operator_missing:${index}`);
      continue;
    }

    const operator = workflowOperatorRegistry.get(operatorId);
    if (!operator) {
      diagnostics.push(`workflow_condition_unknown:${operatorId}`);
    } else if (operator.kind !== "condition") {
      diagnostics.push(`workflow_condition_wrong_kind:${operatorId}`);
    }
  }

  const actions = Array.isArray(definition.actions) ? definition.actions : [];
  if (actions.length === 0) {
    diagnostics.push("workflow_actions_missing");
  }

  for (const [index, entry] of actions.entries()) {
    if (!isRecord(entry)) {
      diagnostics.push(`workflow_action_invalid:${index}`);
      continue;
    }

    const operatorId = typeof entry.operatorId === "string" ? entry.operatorId : null;
    if (!operatorId) {
      diagnostics.push(`workflow_action_operator_missing:${index}`);
      continue;
    }

    const operator = workflowOperatorRegistry.get(operatorId);
    if (!operator) {
      diagnostics.push(`workflow_action_unknown:${operatorId}`);
      continue;
    }

    if (operator.kind !== "action") {
      diagnostics.push(`workflow_action_wrong_kind:${operatorId}`);
      continue;
    }

    if (
      !options.allowEmptyActionInputs &&
      (!isRecord(entry.input) || Object.keys(entry.input).length === 0)
    ) {
      diagnostics.push(`workflow_action_input_missing:${operatorId}`);
    }

    if (options.requirePublishableActions && !isSupportedDomainCommandType(operator.commandType)) {
      diagnostics.push(`workflow_action_command_unsupported:${operator.commandType}`);
    }
  }

  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
