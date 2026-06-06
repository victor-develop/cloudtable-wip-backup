import type { JsonSchema } from "../field-types/types";

export type AgentToolScope = "app" | "table" | "view" | "workflow";
export type AgentToolPhase = "draft" | "preview" | "execute";
export type AgentToolMutationTarget =
  | "none"
  | "records"
  | "schema"
  | "view"
  | "workflow";
export type AgentToolFieldBinding =
  | "none"
  | "all-visible-fields"
  | "explicit-field-ids";

export type AgentToolDefinition = {
  id: string;
  description: string;
  fieldBinding: AgentToolFieldBinding;
  fieldIds?: readonly string[];
  inputSchema: JsonSchema;
  mutating: boolean;
  mutationTarget: AgentToolMutationTarget;
  outputSchema: JsonSchema;
  phase: AgentToolPhase;
  requiresConfirmation: boolean;
  scope: AgentToolScope;
  successorToolId?: string;
};

export type AgentToolAccessPlan = {
  allowed: boolean;
  hiddenFieldIds: string[];
  reason: string | null;
  toolId: string;
  visibleFieldIds: string[];
};

export type AgentToolSanitizationResult = {
  diagnostics: string[];
  hiddenFieldIds: string[];
  sanitized: Record<string, unknown>;
};

export type AgentToolRegistry = {
  list(): AgentToolDefinition[];
  get(toolId: string): AgentToolDefinition | undefined;
  require(toolId: string): AgentToolDefinition;
  listAccessible(
    fields: readonly {
      fieldId: string;
      fieldType: string;
    }[],
    snapshot?: import("../permissions/types").EffectivePermissionSnapshot
  ): AgentToolAccessPlan[];
  sanitizeInput(
    toolId: string,
    payload: Record<string, unknown>,
    fields: readonly {
      fieldId: string;
      fieldType: string;
    }[],
    snapshot?: import("../permissions/types").EffectivePermissionSnapshot
  ): AgentToolSanitizationResult;
  sanitizeOutput(
    toolId: string,
    payload: Record<string, unknown>,
    fields: readonly {
      fieldId: string;
      fieldType: string;
    }[],
    snapshot?: import("../permissions/types").EffectivePermissionSnapshot
  ): AgentToolSanitizationResult;
};
