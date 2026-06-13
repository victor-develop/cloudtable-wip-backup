export type WorkflowServiceIdentity = {
  policyRevision: number;
  principalId: string;
  schemaEpoch: number;
  scopeHash: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireWorkflowServiceIdentityMetadata(
  definition: unknown,
  input: { workflowId: string; workflowVersionId: string }
): WorkflowServiceIdentity {
  const principal =
    isRecord(definition) && isRecord(definition.principal) ? definition.principal : null;
  if (!principal) {
    throw new Error(
      `Workflow ${input.workflowId} version ${input.workflowVersionId} is missing explicit workflow service identity metadata.`
    );
  }

  const principalId = readNonEmptyString(principal.principalId);
  const policyRevision = readFiniteNumber(principal.policyRevision);
  const schemaEpoch = readFiniteNumber(principal.schemaEpoch);
  const scopeHash = readNonEmptyString(principal.scopeHash);
  const invalidFields = [
    principalId === null ? "principalId" : null,
    policyRevision === null ? "policyRevision" : null,
    schemaEpoch === null ? "schemaEpoch" : null,
    scopeHash === null ? "scopeHash" : null
  ].filter((field): field is string => field !== null);

  if (invalidFields.length > 0) {
    throw new Error(
      `Workflow ${input.workflowId} version ${input.workflowVersionId} has invalid explicit workflow service identity metadata: ${invalidFields.join(", ")}.`
    );
  }

  return {
    policyRevision: policyRevision as number,
    principalId: principalId as string,
    schemaEpoch: schemaEpoch as number,
    scopeHash: scopeHash as string
  };
}
