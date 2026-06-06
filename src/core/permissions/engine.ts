import type { CommandEnvelope } from "../commands/types";
import type { FieldTypeRegistry } from "../field-types/types";
import type {
  AgentToolAccess,
  AgentToolFieldVisibility,
  EffectivePermissionSnapshot,
  FieldAccessDecision,
  FieldReadState,
  PermissionDecision,
  PermissionEngine,
  PermissionFieldDescriptor,
  PermissionProjection,
  PermissionSurface
} from "./types";

type CreatePermissionEngineOptions = {
  snapshot?: EffectivePermissionSnapshot;
};

type ResolvedFieldAccess = EffectivePermissionSnapshot["fields"][string];

function fieldReasonPrefix(surface: PermissionSurface): string {
  switch (surface) {
    case "workflow-step":
      return "workflow";
    case "agent-tool":
      return "agent";
    default:
      return "field";
  }
}

function resolveFieldAccess(
  field: PermissionFieldDescriptor,
  fieldTypeRegistry: FieldTypeRegistry,
  snapshot?: EffectivePermissionSnapshot
): ResolvedFieldAccess {
  const explicit = snapshot?.fields[field.fieldId];
  if (explicit) {
    return explicit;
  }

  const definition = fieldTypeRegistry.require(field.fieldType);
  const behavior = definition.getPermissionBehavior({
    fieldType: field.fieldType
  });

  return {
    ...field,
    read: "visible",
    write: behavior.allowsMutation,
    workflow: behavior.allowsWorkflowTrigger,
    agent: definition.capabilities.supportsAgentMutation
  };
}

function readStateForSurface(
  access: ResolvedFieldAccess,
  surface: PermissionSurface
): FieldReadState {
  if (surface === "workflow-step" && !access.workflow) {
    return "hidden";
  }

  if (surface === "agent-tool" && !access.agent) {
    return "hidden";
  }

  return access.read;
}

function redactValue(
  value: unknown,
  readState: FieldReadState,
  redaction: "none" | "display_only" | "full"
): unknown {
  if (readState !== "redacted") {
    return value;
  }

  switch (redaction) {
    case "display_only":
      return "[redacted]";
    case "full":
      return null;
    default:
      return "[redacted]";
  }
}

function extractFieldEdits(
  command: CommandEnvelope
): Array<PermissionFieldDescriptor & { value?: unknown }> {
  const payload = command.payload as Record<string, unknown>;

  if (Array.isArray(payload.fieldEdits)) {
    return payload.fieldEdits
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        fieldId: String(entry.fieldId ?? ""),
        fieldType: String(entry.fieldType ?? ""),
        value: entry.value
      }))
      .filter((entry) => entry.fieldId !== "");
  }

  if (typeof payload.fieldId === "string" && typeof payload.fieldType === "string") {
    return [
      {
        fieldId: payload.fieldId,
        fieldType: payload.fieldType,
        value: payload.value
      }
    ];
  }

  return [];
}

export function createPermissionEngine(
  fieldTypeRegistry: FieldTypeRegistry,
  options: CreatePermissionEngineOptions = {}
): PermissionEngine {
  const defaultSnapshot = options.snapshot;

  return {
    describeField(fieldType) {
      return fieldTypeRegistry.require(fieldType).getPermissionBehavior({
        fieldType
      });
    },
    evaluateFieldAccess(field, surface, snapshot = defaultSnapshot) {
      const definition = fieldTypeRegistry.require(field.fieldType);
      const behavior = definition.getPermissionBehavior({
        fieldType: field.fieldType
      });
      const resolved = resolveFieldAccess(field, fieldTypeRegistry, snapshot);
      const readState = readStateForSurface(resolved, surface);
      const reasons: string[] = [];

      if (readState === "hidden") {
        reasons.push(`${fieldReasonPrefix(surface)}_hidden:${field.fieldId}`);
      } else if (readState === "redacted") {
        reasons.push(`${fieldReasonPrefix(surface)}_redacted:${field.fieldId}`);
      }

      if (!resolved.write || !behavior.allowsMutation) {
        reasons.push(`field_read_only:${field.fieldId}`);
      }

      if (surface === "agent-tool" && !definition.capabilities.supportsAgentMutation) {
        reasons.push(`field_not_agent_mutable:${field.fieldId}`);
      }

      const writeAllowed =
        readState !== "hidden" &&
        resolved.write &&
        behavior.allowsMutation &&
        (surface !== "agent-tool" || definition.capabilities.supportsAgentMutation);

      return {
        allowed: readState !== "hidden" || writeAllowed,
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        readState,
        reasons,
        writeAllowed
      } satisfies FieldAccessDecision;
    },
    evaluateCommand(command, snapshot = defaultSnapshot) {
      const reasons: string[] = [];

      if (snapshot) {
        if (snapshot.workspaceId !== command.workspaceId) {
          reasons.push("permission_workspace_mismatch");
        }

        if (snapshot.principalId !== command.actor.principalId) {
          reasons.push("permission_principal_mismatch");
        }

        if (
          typeof command.permissionsVersion === "number" &&
          command.permissionsVersion !== snapshot.policyRevision
        ) {
          reasons.push("permission_stale");
        }

        if (
          typeof command.schemaEpoch === "number" &&
          command.schemaEpoch !== snapshot.schemaEpoch
        ) {
          reasons.push("schema_scope_stale");
        }

        if (
          typeof command.permissionScopeHash === "string" &&
          command.permissionScopeHash !== snapshot.scopeHash
        ) {
          reasons.push("permission_scope_mismatch");
        }

        if (
          snapshot.commandTypes &&
          !snapshot.commandTypes.includes(command.commandType)
        ) {
          reasons.push(`command_type_denied:${command.commandType}`);
        }
      }

      for (const field of extractFieldEdits(command)) {
        if (field.fieldType === "") {
          reasons.push(`field_type_missing:${field.fieldId}`);
          continue;
        }

        const writeAccess = this.evaluateFieldAccess(field, "command-ingress", snapshot);
        if (!writeAccess.writeAllowed) {
          reasons.push(...writeAccess.reasons.filter((reason) => reason.startsWith("field_")));
        }

        if (command.actor.mode === "workflow") {
          const workflowAccess = this.evaluateFieldAccess(field, "workflow-step", snapshot);
          if (workflowAccess.readState === "hidden") {
            reasons.push(`workflow_hidden:${field.fieldId}`);
          }
        }

        if (command.actor.mode === "agent") {
          const agentAccess = this.evaluateFieldAccess(field, "agent-tool", snapshot);
          if (agentAccess.readState === "hidden") {
            reasons.push(`agent_hidden:${field.fieldId}`);
          }
          if (!agentAccess.writeAllowed) {
            reasons.push(...agentAccess.reasons.filter((reason) => reason.startsWith("field_")));
          }
        }
      }

      return {
        allowed: reasons.length === 0,
        reasons: Array.from(new Set(reasons))
      } satisfies PermissionDecision;
    },
    projectFields(fields, surface, snapshot = defaultSnapshot) {
      const projected: PermissionProjection = {
        diagnostics: [],
        fields: {},
        hiddenFieldIds: [],
        redactedFieldIds: [],
        states: {}
      };

      for (const field of fields) {
        const access = this.evaluateFieldAccess(field, surface, snapshot);
        const behavior = this.describeField(field.fieldType);

        projected.states[field.fieldId] = access.readState;

        if (access.readState === "hidden") {
          projected.hiddenFieldIds.push(field.fieldId);
          projected.diagnostics.push(...access.reasons);
          continue;
        }

        if (access.readState === "redacted") {
          projected.redactedFieldIds.push(field.fieldId);
          projected.diagnostics.push(...access.reasons);
        }

        projected.fields[field.fieldId] = redactValue(
          field.value,
          access.readState,
          behavior.readRedaction
        );
      }

      projected.diagnostics = Array.from(new Set(projected.diagnostics));
      return projected;
    },
    filterAgentTools(tools, fields, snapshot = defaultSnapshot) {
      const visibility = this.resolveAgentToolFieldVisibility(fields, snapshot);

      return tools.map((tool) => {
        const scopedVisibility =
          tool.fieldBinding === "none"
            ? emptyAgentToolVisibility()
            : resolveScopedVisibility(tool.fieldIds, visibility);
        const requiresWritableFields =
          tool.mutating && tool.mutationTarget === "records";
        const allowed = !requiresWritableFields || scopedVisibility.writableFieldIds.length > 0;

        return {
          allowed,
          hiddenFieldIds: scopedVisibility.hiddenFieldIds,
          reason: allowed ? null : "agent_mutation_denied",
          toolId: tool.id,
          visibleFieldIds: scopedVisibility.visibleFieldIds
        } satisfies AgentToolAccess;
      });
    },
    resolveAgentToolFieldVisibility(fields, snapshot = defaultSnapshot) {
      const visibility: AgentToolFieldVisibility = {
        hiddenFieldIds: [],
        visibleFieldIds: [],
        writableFieldIds: []
      };

      for (const field of fields) {
        const access = this.evaluateFieldAccess(field, "agent-tool", snapshot);
        if (access.readState === "hidden") {
          visibility.hiddenFieldIds.push(field.fieldId);
          continue;
        }

        visibility.visibleFieldIds.push(field.fieldId);
        if (access.writeAllowed) {
          visibility.writableFieldIds.push(field.fieldId);
        }
      }

      return visibility;
    },
    listSurfaces() {
      return [
        "command-ingress",
        "direct-record-read",
        "view-query",
        "workflow-step",
        "agent-tool"
      ];
    }
  };
}

function resolveScopedVisibility(
  fieldIds: readonly string[] | undefined,
  visibility: AgentToolFieldVisibility
): AgentToolFieldVisibility {
  if (!fieldIds) {
    return visibility;
  }

  const wanted = new Set(fieldIds);
  return {
    hiddenFieldIds: visibility.hiddenFieldIds.filter((fieldId) => wanted.has(fieldId)),
    visibleFieldIds: visibility.visibleFieldIds.filter((fieldId) => wanted.has(fieldId)),
    writableFieldIds: visibility.writableFieldIds.filter((fieldId) => wanted.has(fieldId))
  };
}

function emptyAgentToolVisibility(): AgentToolFieldVisibility {
  return {
    hiddenFieldIds: [],
    visibleFieldIds: [],
    writableFieldIds: []
  };
}
