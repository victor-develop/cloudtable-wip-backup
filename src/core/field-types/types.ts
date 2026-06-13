export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchema = {
  type: string;
  additionalProperties?: boolean;
  description?: string;
  enum?: readonly JsonValue[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  default?: JsonValue;
};

export type FieldTypeCapabilities = {
  scalar: boolean;
  multiValue: boolean;
  reference: boolean;
  computed: boolean;
  userEditable: boolean;
  supportsUniqueConstraint: boolean;
  supportsRequiredConstraint: boolean;
  supportsDefaultValue: boolean;
  supportsFiltering: boolean;
  supportsSorting: boolean;
  supportsGrouping: boolean;
  supportsSearch: boolean;
  supportsWorkflowTrigger: boolean;
  supportsAgentMutation: boolean;
};

export type NormalizeWarning = {
  code: string;
  message: string;
};

export type NormalizedCellValue = {
  valueType: string;
  version: number;
  raw: JsonValue | null;
  isEmpty: boolean;
  tokens?: readonly string[];
  refs?: readonly string[];
  meta?: Record<string, JsonValue>;
};

export type NormalizeResult = {
  value: NormalizedCellValue | null;
  warnings: readonly NormalizeWarning[];
};

export type ValidationResult = {
  valid: boolean;
  errors: readonly string[];
};

export type FieldIndexValue = {
  textValue?: string | null;
  numberValue?: string | null;
  boolValue?: boolean | null;
  datetimeValue?: string | null;
  referenceValue?: string | null;
  displayValue: string;
  searchText: string;
  valueHash: string;
};

export type FieldPermissionBehavior = {
  readRedaction: "none" | "display_only" | "full";
  allowsMutation: boolean;
  allowsWorkflowTrigger: boolean;
  supportsValueVisibilityRules: boolean;
};

export type NormalizeContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type FieldSchemaContext = {
  fieldType: string;
};

export type CellValidationContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type DefaultValueContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type DisplayContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type IndexContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type SearchContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type OperatorContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type FieldWorkflowProposalHint = {
  draftInput?: Record<string, JsonValue>;
  operatorId: string;
  matchPhrases: readonly string[];
  matchFieldPhrases?: readonly string[];
};

export type FieldWorkflowBindingAlias = {
  binding: string;
  isCanonical?: boolean;
};

export type WorkflowProposalHintContext = {
  aliasOf?: string;
  binding: string;
  bindingKind: "field" | "alias";
  fieldType: string;
  fieldConfig?: JsonValue;
  isCanonical?: boolean;
};

export type WorkflowBindingAliasContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type SortContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type PermissionContext = {
  fieldType: string;
  fieldConfig?: JsonValue;
};

export type FieldTypeFixture =
  | {
      id: string;
      kind: "normalize";
      input: unknown;
      expected: {
        value: NormalizedCellValue | null;
        warnings?: readonly NormalizeWarning[];
        display: string;
        searchText: string;
        index: FieldIndexValue;
      };
    }
  | {
      id: string;
      kind: "invalid_config";
      config: unknown;
      expectedErrors: readonly string[];
    }
  | {
      id: string;
      kind: "invalid_value";
      fieldConfig?: JsonValue;
    } & (
      | {
          input: unknown;
          expected: {
            value: NormalizedCellValue | null;
            warnings?: readonly NormalizeWarning[];
            errors: readonly string[];
          };
        }
      | {
          value: NormalizedCellValue | null;
          expected: {
            errors: readonly string[];
          };
        }
    )
  | {
      id: string;
      kind: "operators";
      expectedConditionOperators: readonly string[];
      expectedSortModes: readonly string[];
    }
  | {
      id: string;
      kind: "permission";
      expected: FieldPermissionBehavior;
    };

export type FieldTypeDefinition = {
  type: string;
  version: number;
  capabilities: FieldTypeCapabilities;
  configSchema: JsonSchema;
  valueSchema: JsonSchema;
  defaultConfig: JsonValue;
  supportedConditionOperators: readonly string[];
  supportedSortModes: readonly string[];
  normalize(input: unknown, context: NormalizeContext): NormalizeResult;
  validateConfig(config: unknown, context: FieldSchemaContext): ValidationResult;
  validateValue(value: NormalizedCellValue | null, context: CellValidationContext): ValidationResult;
  applyDefault(context: DefaultValueContext): NormalizedCellValue | null;
  toDisplay(value: NormalizedCellValue | null, context: DisplayContext): string;
  toIndex(value: NormalizedCellValue | null, context: IndexContext): FieldIndexValue;
  toSearchText(value: NormalizedCellValue | null, context: SearchContext): string;
  getSupportedConditionOperators(context: OperatorContext): readonly string[];
  getWorkflowBindingAliases(context: WorkflowBindingAliasContext): readonly FieldWorkflowBindingAlias[];
  getWorkflowProposalHints(context: WorkflowProposalHintContext): readonly FieldWorkflowProposalHint[];
  getSupportedSortModes(context: SortContext): readonly string[];
  getPermissionBehavior(context: PermissionContext): FieldPermissionBehavior;
  fixtures: readonly FieldTypeFixture[];
};

export type FieldTypeManifest = {
  type: string;
  version: number;
  capabilities: FieldTypeCapabilities;
  configSchema: JsonSchema;
  valueSchema: JsonSchema;
  defaultConfig: JsonValue;
  supportedConditionOperators: readonly string[];
  supportedSortModes: readonly string[];
  permissionBehavior: FieldPermissionBehavior;
};

export type FieldTypeRegistry = {
  get(type: string): FieldTypeDefinition | undefined;
  has(type: string): boolean;
  list(): readonly FieldTypeDefinition[];
  require(type: string): FieldTypeDefinition;
};

export type CreateFieldTypeRegistryInput = {
  fieldTypes?: readonly FieldTypeDefinition[];
};
