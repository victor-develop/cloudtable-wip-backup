import type { CommandBus } from "../commands/command-bus";
import type {
  EffectivePermissionSnapshot,
  PermissionEngine,
  PermissionFieldDescriptor
} from "../permissions/types";
import type {
  AgentToolDefinition,
  AgentToolRegistry,
  AgentToolSanitizationResult
} from "./types";

const jsonStringSchema = {
  type: "string"
} as const;

const jsonFieldRefSchema = {
  properties: {
    fieldId: jsonStringSchema
  },
  type: "object"
} as const;

const tools: AgentToolDefinition[] = [
  {
    description: "Draft a table schema proposal from a natural-language brief.",
    fieldBinding: "none",
    id: "schema.draft",
    inputSchema: {
      properties: {
        brief: {
          description: "Natural-language table brief.",
          type: "string"
        },
        tableName: {
          type: "string"
        }
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        fieldDrafts: {
          items: jsonFieldRefSchema,
          type: "array"
        },
        notes: {
          items: jsonStringSchema,
          type: "array"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "table"
  },
  {
    description: "Preview the schema command plan required to create new fields.",
    fieldBinding: "none",
    id: "field.create.preview",
    inputSchema: {
      properties: {
        fields: {
          items: jsonFieldRefSchema,
          type: "array"
        }
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        commandPlan: {
          items: jsonStringSchema,
          type: "array"
        },
        proposedFieldIds: {
          items: jsonStringSchema,
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "field.create.execute"
  },
  {
    description: "Commit field creation commands after a reviewed preview.",
    fieldBinding: "none",
    id: "field.create.execute",
    inputSchema: {
      properties: {
        fields: {
          items: jsonFieldRefSchema,
          type: "array"
        },
        previewToken: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        eventIds: {
          items: jsonStringSchema,
          type: "array"
        },
        createdFieldIds: {
          items: jsonStringSchema,
          type: "array"
        }
      },
      type: "object"
    },
    phase: "execute",
    requiresConfirmation: true,
    scope: "table"
  },
  {
    description: "Draft role-focused view configurations from the visible schema surface.",
    fieldBinding: "all-visible-fields",
    id: "view.generate",
    inputSchema: {
      properties: {
        roleName: jsonStringSchema,
        visibleFieldIds: {
          items: jsonStringSchema,
          type: "array"
        }
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        filters: {
          items: jsonFieldRefSchema,
          type: "array"
        },
        groupByFieldId: jsonStringSchema,
        sortFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        visibleFieldIds: {
          items: jsonStringSchema,
          type: "array"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "view"
  },
  {
    description: "Draft a workflow trigger, conditions, and actions from a business rule.",
    fieldBinding: "all-visible-fields",
    id: "workflow.draft",
    inputSchema: {
      properties: {
        businessRule: jsonStringSchema,
        fieldIds: {
          items: jsonStringSchema,
          type: "array"
        }
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        actions: {
          items: jsonFieldRefSchema,
          type: "array"
        },
        conditions: {
          items: jsonFieldRefSchema,
          type: "array"
        },
        trigger: jsonFieldRefSchema
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "workflow"
  },
  {
    description: "Explain why a principal can or cannot edit a visible field or view action.",
    fieldBinding: "explicit-field-ids",
    id: "permission.explain",
    inputSchema: {
      properties: {
        fieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        principalId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        explanations: {
          items: {
            properties: {
              fieldId: jsonStringSchema,
              reason: jsonStringSchema
            },
            type: "object"
          },
          type: "array"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "app"
  },
  {
    description: "Preview a scoped bulk update against view-visible records and fields.",
    fieldBinding: "explicit-field-ids",
    id: "bulk_update.preview",
    inputSchema: {
      properties: {
        updates: {
          items: {
            properties: {
              fieldId: jsonStringSchema,
              value: {
                type: "string"
              }
            },
            type: "object"
          },
          type: "array"
        },
        viewId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        impactedFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        records: {
          items: {
            properties: {
              fields: {
                type: "object"
              },
              recordId: jsonStringSchema
            },
            type: "object"
          },
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "view",
    successorToolId: "bulk_update.execute"
  },
  {
    description: "Commit a reviewed scoped bulk update with the caller's idempotency context.",
    fieldBinding: "explicit-field-ids",
    id: "bulk_update.execute",
    inputSchema: {
      properties: {
        previewToken: jsonStringSchema,
        updates: {
          items: {
            properties: {
              fieldId: jsonStringSchema,
              value: {
                type: "string"
              }
            },
            type: "object"
          },
          type: "array"
        },
        viewId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "records",
    outputSchema: {
      properties: {
        eventIds: {
          items: jsonStringSchema,
          type: "array"
        },
        impactedFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        records: {
          items: {
            properties: {
              fields: {
                type: "object"
              },
              recordId: jsonStringSchema
            },
            type: "object"
          },
          type: "array"
        }
      },
      type: "object"
    },
    phase: "execute",
    requiresConfirmation: true,
    scope: "view"
  }
];

const fieldIdArrayKeys = new Set([
  "fieldIds",
  "filterFieldIds",
  "impactedFieldIds",
  "proposedFieldIds",
  "sortFieldIds",
  "visibleFieldIds"
]);

const singularFieldIdKeys = new Set([
  "fieldId",
  "groupByFieldId",
  "targetFieldId"
]);

export function createAgentToolRegistry(
  permissionEngine: PermissionEngine,
  _commandBus: CommandBus
): AgentToolRegistry {
  return {
    list() {
      return [...tools];
    },
    get(toolId) {
      return tools.find((tool) => tool.id === toolId);
    },
    require(toolId) {
      const tool = this.get(toolId);
      if (!tool) {
        throw new Error(`Unknown agent tool: ${toolId}`);
      }

      return tool;
    },
    listAccessible(fields, snapshot) {
      return permissionEngine.filterAgentTools(tools, fields, snapshot);
    },
    sanitizeInput(toolId, payload, fields, snapshot) {
      this.require(toolId);
      return sanitizePayload(permissionEngine, payload, fields, snapshot);
    },
    sanitizeOutput(toolId, payload, fields, snapshot) {
      this.require(toolId);
      return sanitizePayload(permissionEngine, payload, fields, snapshot);
    }
  };
}

function sanitizePayload(
  permissionEngine: PermissionEngine,
  payload: Record<string, unknown>,
  fields: readonly PermissionFieldDescriptor[],
  snapshot?: EffectivePermissionSnapshot
): AgentToolSanitizationResult {
  const visibility = permissionEngine.resolveAgentToolFieldVisibility(fields, snapshot);
  const hiddenFieldIds = new Set(visibility.hiddenFieldIds);
  const diagnostics = new Set<string>();
  const removedFieldIds = new Set<string>();

  const sanitized = sanitizeUnknown(payload, hiddenFieldIds, removedFieldIds);

  for (const fieldId of removedFieldIds) {
    diagnostics.add(`agent_hidden:${fieldId}`);
  }

  return {
    diagnostics: [...diagnostics],
    hiddenFieldIds: [...removedFieldIds],
    sanitized: isRecord(sanitized) ? sanitized : {}
  };
}

function sanitizeUnknown(
  value: unknown,
  hiddenFieldIds: ReadonlySet<string>,
  removedFieldIds: Set<string>
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeUnknown(entry, hiddenFieldIds, removedFieldIds))
      .filter((entry) => entry !== undefined);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (typeof value.fieldId === "string" && hiddenFieldIds.has(value.fieldId)) {
    removedFieldIds.add(value.fieldId);
    return undefined;
  }

  const sanitizedEntries: Array<[string, unknown]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (singularFieldIdKeys.has(key) && typeof entry === "string") {
      if (hiddenFieldIds.has(entry)) {
        removedFieldIds.add(entry);
        continue;
      }

      sanitizedEntries.push([key, entry]);
      continue;
    }

    if (fieldIdArrayKeys.has(key) && Array.isArray(entry)) {
      const visibleFieldIds = entry.filter((item): item is string => {
        if (typeof item !== "string") {
          return false;
        }

        if (hiddenFieldIds.has(item)) {
          removedFieldIds.add(item);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, visibleFieldIds]);
      continue;
    }

    if (key === "fields" && isRecord(entry)) {
      const visibleEntries = Object.entries(entry).filter(([fieldId]) => {
        if (hiddenFieldIds.has(fieldId)) {
          removedFieldIds.add(fieldId);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, Object.fromEntries(visibleEntries)]);
      continue;
    }

    const sanitizedEntry = sanitizeUnknown(entry, hiddenFieldIds, removedFieldIds);
    if (sanitizedEntry !== undefined) {
      sanitizedEntries.push([key, sanitizedEntry]);
    }
  }

  return Object.fromEntries(sanitizedEntries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
