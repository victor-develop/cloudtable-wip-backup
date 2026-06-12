import type { JsonValue } from "../field-types/types";
import type { CommandEnvelope } from "../commands/types";
import type { FieldPermissionBehavior } from "../field-types/types";
import type { AgentToolDefinition } from "../agent-tools/types";

export type PermissionDecision = {
  allowed: boolean;
  reasons: string[];
};

export type PermissionSurface =
  | "command-ingress"
  | "direct-record-read"
  | "view-query"
  | "workflow-step"
  | "agent-tool";

export type FieldReadState = "visible" | "redacted" | "hidden";

export type PermissionFieldDescriptor = {
  fieldId: string;
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type PermissionFieldAccess = PermissionFieldDescriptor & {
  read: FieldReadState;
  write: boolean;
  workflow: boolean;
  agent: boolean;
};

export type EffectivePermissionSnapshot = {
  snapshotId: string;
  workspaceId: string;
  principalId: string;
  policyRevision: number;
  schemaEpoch: number;
  scopeHash: string;
  commandTypes?: readonly string[];
  fields: Record<string, PermissionFieldAccess>;
};

export type PermissionRowOwnerContext = {
  fieldId: string;
  fieldType: string;
  matchesPrincipal: boolean;
  principalIds: string[];
  recordId: string;
};

export type PermissionEvaluationContext = {
  rowOwner?: PermissionRowOwnerContext;
};

export type FieldAccessDecision = {
  allowed: boolean;
  evaluationContext?: PermissionEvaluationContext;
  fieldId: string;
  fieldType: string;
  readState: FieldReadState;
  writeAllowed: boolean;
  reasons: string[];
};

export type ExplainablePermissionSurface =
  | "direct-record-read"
  | "view-query"
  | "command-ingress"
  | "workflow-step"
  | "agent-tool";

export type PermissionSurfaceExplanation = {
  surface: ExplainablePermissionSurface;
  allowed: boolean;
  evaluationContext?: PermissionEvaluationContext;
  readState: FieldReadState;
  writeAllowed: boolean;
  reasons: string[];
  reasonMessages: string[];
  message: string;
};

export type FieldPermissionExplanation = {
  evaluationContext?: PermissionEvaluationContext;
  fieldId: string;
  fieldType: string;
  surfaces: PermissionSurfaceExplanation[];
};

export type PermissionProjectionInput = PermissionFieldDescriptor & {
  value: unknown;
};

export type PermissionProjection = {
  fields: Record<string, unknown>;
  states: Record<string, FieldReadState>;
  hiddenFieldIds: string[];
  redactedFieldIds: string[];
  diagnostics: string[];
};

export type AgentToolAccess = {
  toolId: string;
  allowed: boolean;
  reason: string | null;
  visibleFieldIds: string[];
  hiddenFieldIds: string[];
};

export type AgentToolFieldVisibility = {
  hiddenFieldIds: string[];
  visibleFieldIds: string[];
  writableFieldIds: string[];
};

export type PermissionEngine = {
  describeField(fieldType: string): FieldPermissionBehavior;
  evaluateFieldAccess(
    field: PermissionFieldDescriptor,
    surface: PermissionSurface,
    snapshot?: EffectivePermissionSnapshot,
    evaluationContext?: PermissionEvaluationContext
  ): FieldAccessDecision;
  explainFieldAccess(
    field: PermissionFieldDescriptor,
    surfaces?: readonly ExplainablePermissionSurface[],
    snapshot?: EffectivePermissionSnapshot,
    evaluationContext?: PermissionEvaluationContext
  ): FieldPermissionExplanation;
  evaluateCommand(
    command: CommandEnvelope,
    snapshot?: EffectivePermissionSnapshot
  ): PermissionDecision;
  projectFields(
    fields: readonly PermissionProjectionInput[],
    surface: PermissionSurface,
    snapshot?: EffectivePermissionSnapshot
  ): PermissionProjection;
  filterAgentTools(
    tools: readonly AgentToolDefinition[],
    fields: readonly PermissionFieldDescriptor[],
    snapshot?: EffectivePermissionSnapshot
  ): AgentToolAccess[];
  resolveAgentToolFieldVisibility(
    fields: readonly PermissionFieldDescriptor[],
    snapshot?: EffectivePermissionSnapshot
  ): AgentToolFieldVisibility;
  listSurfaces(): PermissionSurface[];
};
