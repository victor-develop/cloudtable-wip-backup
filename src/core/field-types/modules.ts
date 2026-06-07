import type {
  FieldIndexValue,
  FieldPermissionBehavior,
  FieldTypeCapabilities,
  FieldTypeDefinition,
  JsonSchema,
  JsonValue,
  NormalizedCellValue,
  NormalizeResult
} from "./types";

const baseCapabilities: FieldTypeCapabilities = {
  scalar: true,
  multiValue: false,
  reference: false,
  computed: false,
  userEditable: true,
  supportsUniqueConstraint: true,
  supportsRequiredConstraint: true,
  supportsDefaultValue: true,
  supportsFiltering: true,
  supportsSorting: true,
  supportsGrouping: true,
  supportsSearch: true,
  supportsWorkflowTrigger: true,
  supportsAgentMutation: true
};

const basePermissionBehavior: FieldPermissionBehavior = {
  readRedaction: "none",
  allowsMutation: true,
  allowsWorkflowTrigger: true,
  supportsValueVisibilityRules: false
};

type ModuleFixtureInput = {
  type: string;
  version?: number;
  capabilities?: Partial<FieldTypeCapabilities>;
  configSchema?: JsonSchema;
  valueSchema?: JsonSchema;
  defaultConfig?: JsonValue;
  supportedConditionOperators?: readonly string[];
  supportedSortModes?: readonly string[];
  permissionBehavior?: Partial<FieldPermissionBehavior>;
  sampleInput: unknown;
  normalizeSample: (input: unknown) => NormalizeResult;
  indexSample: (value: NormalizedCellValue | null) => FieldIndexValue;
};

type SelectOption = {
  color?: string;
  description?: string;
  id: string;
  label: string;
  order: number;
  semantic?: string;
};

type ParsedSelectConfig = {
  hasOptions: boolean;
  options: readonly SelectOption[];
  optionsById: ReadonlyMap<string, SelectOption>;
};

const statusSemantics = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled"
] as const;

function stableHash(value: JsonValue): string {
  return JSON.stringify(value);
}

function normalizeTextTokens(text: string): readonly string[] {
  const normalized = text.trim().toLowerCase();

  return normalized === "" ? [] : normalized.split(/\s+/);
}

function coerceScalarText(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }

  if (input == null) {
    return "";
  }

  return String(input).trim();
}

function buildNormalizedValue(
  type: string,
  raw: JsonValue | null,
  version = 1,
  extras: Partial<NormalizedCellValue> = {}
): NormalizedCellValue {
  return {
    valueType: type,
    version,
    raw,
    isEmpty:
      raw == null ||
      raw === "" ||
      (Array.isArray(raw) && raw.length === 0),
    ...extras
  };
}

function defineFieldType(input: ModuleFixtureInput): FieldTypeDefinition {
  const version = input.version ?? 1;
  const supportedConditionOperators = input.supportedConditionOperators ?? [
    "equals",
    "not_equals",
    "is_empty",
    "is_not_empty"
  ];
  const supportedSortModes = input.supportedSortModes ?? ["ascending", "descending"];
  const permissionBehavior = {
    ...basePermissionBehavior,
    ...input.permissionBehavior
  };

  return {
    type: input.type,
    version,
    capabilities: {
      ...baseCapabilities,
      ...input.capabilities
    },
    configSchema: input.configSchema ?? {
      type: "object",
      description: "Placeholder MVP config schema."
    },
    valueSchema: input.valueSchema ?? {
      type: "string",
      description: "Placeholder MVP value schema."
    },
    defaultConfig: input.defaultConfig ?? {},
    supportedConditionOperators,
    supportedSortModes,
    normalize(rawInput) {
      return input.normalizeSample(rawInput);
    },
    validateConfig(config) {
      return {
        valid: typeof config === "object" && config !== null,
        errors:
          typeof config === "object" && config !== null
            ? []
            : ["Field configuration must be an object."]
      };
    },
    validateValue(value) {
      return {
        valid: value == null || value.valueType === input.type,
        errors:
          value == null || value.valueType === input.type
            ? []
            : [`Expected ${input.type} value, received ${value.valueType}.`]
      };
    },
    applyDefault() {
      return null;
    },
    toDisplay(value) {
      return input.indexSample(value).displayValue;
    },
    toIndex(value) {
      return input.indexSample(value);
    },
    toSearchText(value) {
      return input.indexSample(value).searchText;
    },
    getSupportedConditionOperators() {
      return supportedConditionOperators;
    },
    getSupportedSortModes() {
      return supportedSortModes;
    },
    getPermissionBehavior() {
      return permissionBehavior;
    },
    fixtures: [
      {
        id: `${input.type}.normalize.sample`,
        kind: "normalize",
        input: input.sampleInput,
        expected: {
          ...(() => {
            const normalized = input.normalizeSample(input.sampleInput);
            const indexed = input.indexSample(normalized.value);

            return {
              value: normalized.value,
              warnings: normalized.warnings,
              display: indexed.displayValue,
              searchText: indexed.searchText,
              index: indexed
            };
          })()
        }
      },
      {
        id: `${input.type}.operators.sample`,
        kind: "operators",
        expectedConditionOperators: supportedConditionOperators,
        expectedSortModes: supportedSortModes
      },
      {
        id: `${input.type}.permission.sample`,
        kind: "permission",
        expected: permissionBehavior
      }
    ]
  };
}

function buildTextIndex(value: NormalizedCellValue | null): FieldIndexValue {
  const raw = typeof value?.raw === "string" ? value.raw : "";
  const searchText = normalizeTextTokens(raw).join(" ");

  return {
    textValue: raw === "" ? null : raw,
    displayValue: raw,
    searchText,
    valueHash: stableHash(value?.raw ?? null)
  };
}

function buildNumberIndex(value: NormalizedCellValue | null): FieldIndexValue {
  const raw = typeof value?.raw === "string" ? value.raw : null;

  return {
    numberValue: raw,
    displayValue: raw ?? "",
    searchText: raw ?? "",
    valueHash: stableHash(value?.raw ?? null)
  };
}

function buildBooleanIndex(value: NormalizedCellValue | null): FieldIndexValue {
  const raw = typeof value?.raw === "boolean" ? value.raw : null;

  return {
    boolValue: raw,
    displayValue: raw == null ? "" : raw ? "true" : "false",
    searchText: raw == null ? "" : raw ? "true" : "false",
    valueHash: stableHash(value?.raw ?? null)
  };
}

function buildDateIndex(value: NormalizedCellValue | null): FieldIndexValue {
  const raw = typeof value?.raw === "string" ? value.raw : null;

  return {
    datetimeValue: raw,
    textValue: raw,
    displayValue: raw ?? "",
    searchText: raw ?? "",
    valueHash: stableHash(value?.raw ?? null)
  };
}

function buildReferenceIndex(value: NormalizedCellValue | null): FieldIndexValue {
  const refs = value?.refs ?? [];

  return {
    referenceValue: refs[0] ?? null,
    textValue: refs.join(","),
    displayValue: refs.join(", "),
    searchText: refs.join(" ").toLowerCase(),
    valueHash: stableHash(value?.raw ?? null)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSelectConfig(config: unknown): ParsedSelectConfig {
  if (!isRecord(config) || !Array.isArray(config.options)) {
    return {
      hasOptions: false,
      options: [],
      optionsById: new Map()
    };
  }

  const options: SelectOption[] = [];
  for (const [order, rawOption] of config.options.entries()) {
    if (!isRecord(rawOption)) {
      continue;
    }

    const id = coerceScalarText(rawOption.id);
    const label = coerceScalarText(rawOption.label);
    if (id === "" || label === "") {
      continue;
    }

    const color = coerceScalarText(rawOption.color);
    const description = coerceScalarText(rawOption.description);
    const semantic = coerceScalarText(rawOption.semantic);
    options.push({
      color: color === "" ? undefined : color,
      description: description === "" ? undefined : description,
      id,
      label,
      order,
      semantic: semantic === "" ? undefined : semantic
    });
  }

  return {
    hasOptions: options.length > 0,
    options,
    optionsById: new Map(options.map((option) => [option.id, option]))
  };
}

function validateSelectConfig(
  config: unknown,
  options: {
    requireSemantic: boolean;
    type: string;
  }
): {
  errors: string[];
  valid: boolean;
} {
  if (!isRecord(config)) {
    return {
      valid: false,
      errors: ["Field configuration must be an object."]
    };
  }

  if (config.options === undefined) {
    return {
      valid: true,
      errors: []
    };
  }

  if (!Array.isArray(config.options)) {
    return {
      valid: false,
      errors: ["Field configuration options must be an array."]
    };
  }

  const errors: string[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawOption] of config.options.entries()) {
    if (!isRecord(rawOption)) {
      errors.push(`Field option ${index} must be an object.`);
      continue;
    }

    const id = coerceScalarText(rawOption.id);
    const label = coerceScalarText(rawOption.label);
    if (id === "") {
      errors.push(`Field option ${index} is missing an id.`);
    }
    if (label === "") {
      errors.push(`Field option ${index} is missing a label.`);
    }
    if (id !== "" && seenIds.has(id)) {
      errors.push(`Field option ids must be unique: ${id}.`);
    }
    seenIds.add(id);

    if (options.requireSemantic) {
      const semantic = coerceScalarText(rawOption.semantic);
      if (semantic === "") {
        errors.push(`Status option ${id || index} is missing a semantic value.`);
      } else if (!statusSemantics.includes(semantic as (typeof statusSemantics)[number])) {
        errors.push(
          `Status option ${id || index} has unsupported semantic: ${semantic}.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function compareSelectIds(
  left: string,
  right: string,
  config: ParsedSelectConfig
): number {
  const leftOrder = config.optionsById.get(left)?.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = config.optionsById.get(right)?.order ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return left.localeCompare(right);
}

function optionSearchText(option: SelectOption): string {
  return normalizeTextTokens(
    [option.label, option.description ?? "", option.semantic ?? ""].join(" ")
  ).join(" ");
}

function buildSelectMeta(option: SelectOption | undefined): Record<string, JsonValue> | undefined {
  if (!option) {
    return undefined;
  }

  return {
    optionId: option.id,
    optionLabel: option.label,
    optionOrder: option.order,
    semantic: option.semantic ?? null
  };
}

function normalizeConfiguredSelectValue(type: string, input: unknown, config: unknown): NormalizeResult {
  const raw = coerceScalarText(input);
  const parsedConfig = parseSelectConfig(config);
  const option = parsedConfig.optionsById.get(raw);

  return {
    value: buildNormalizedValue(type, raw, 1, {
      meta: buildSelectMeta(option),
      tokens:
        option != null
          ? optionSearchText(option).split(" ").filter((token) => token !== "")
          : normalizeTextTokens(raw)
    }),
    warnings: []
  };
}

function normalizeConfiguredMultiSelectValue(
  type: string,
  input: unknown,
  config: unknown
): NormalizeResult {
  const parsedConfig = parseSelectConfig(config);
  const values = Array.isArray(input) ? input : [input];
  const raw = values
    .map((value) => coerceScalarText(value))
    .filter((value) => value !== "");
  const canonical = Array.from(new Set(raw)).sort((left, right) =>
    compareSelectIds(left, right, parsedConfig)
  );

  return {
    value: buildNormalizedValue(type, canonical, 1, {
      tokens: canonical.flatMap((value) => {
        const option = parsedConfig.optionsById.get(value);
        return option != null
          ? optionSearchText(option).split(" ").filter((token) => token !== "")
          : normalizeTextTokens(value);
      })
    }),
    warnings:
      raw.length === canonical.length
        ? []
        : [
            {
              code: "select.duplicate_option",
              message: "Duplicate options were removed during normalization."
            }
          ]
  };
}

function validateConfiguredSelectValue(
  type: string,
  value: NormalizedCellValue | null,
  config: unknown,
  options: {
    multiValue: boolean;
  }
): {
  errors: string[];
  valid: boolean;
} {
  if (value == null) {
    return {
      valid: true,
      errors: []
    };
  }

  if (value.valueType !== type) {
    return {
      valid: false,
      errors: [`Expected ${type} value, received ${value.valueType}.`]
    };
  }

  if (options.multiValue && !Array.isArray(value.raw) && value.raw !== null) {
    return {
      valid: false,
      errors: [`Expected ${type} value to be an array.`]
    };
  }

  if (!options.multiValue && typeof value.raw !== "string" && value.raw !== null) {
    return {
      valid: false,
      errors: [`Expected ${type} value to be a string.`]
    };
  }

  const parsedConfig = parseSelectConfig(config);
  if (!parsedConfig.hasOptions) {
    return {
      valid: true,
      errors: []
    };
  }

  const rawIds = options.multiValue
    ? Array.isArray(value.raw)
      ? value.raw.filter((entry): entry is string => typeof entry === "string")
      : []
    : typeof value.raw === "string"
      ? value.raw === ""
        ? []
        : [value.raw]
      : [];
  const unknownIds = rawIds.filter((id) => !parsedConfig.optionsById.has(id));

  return {
    valid: unknownIds.length === 0,
    errors: unknownIds.map((id) => `Unknown option id for ${type}: ${id}.`)
  };
}

function buildConfiguredSelectIndex(
  value: NormalizedCellValue | null,
  config: unknown,
  options: {
    multiValue: boolean;
    sortByOptionOrder: boolean;
  }
): FieldIndexValue {
  const parsedConfig = parseSelectConfig(config);

  if (options.multiValue) {
    const rawValues = Array.isArray(value?.raw)
      ? value.raw.filter((entry): entry is string => typeof entry === "string")
      : [];
    const labels = rawValues.map((id) => parsedConfig.optionsById.get(id)?.label ?? id);
    const displayValue = labels.join(", ");
    const searchText = rawValues
      .flatMap((id) => {
        const option = parsedConfig.optionsById.get(id);
        return option != null
          ? optionSearchText(option).split(" ").filter((token) => token !== "")
          : normalizeTextTokens(id);
      })
      .join(" ");

    return {
      textValue: displayValue === "" ? null : displayValue,
      displayValue,
      searchText,
      valueHash: stableHash(value?.raw ?? null)
    };
  }

  const raw = typeof value?.raw === "string" ? value.raw : "";
  const option = parsedConfig.optionsById.get(raw);
  const displayValue = option?.label ?? raw;
  const searchText =
    option != null ? optionSearchText(option) : normalizeTextTokens(raw).join(" ");

  return {
    numberValue: options.sortByOptionOrder && option != null ? String(option.order) : undefined,
    textValue: displayValue === "" ? null : displayValue,
    displayValue,
    searchText,
    valueHash: stableHash(value?.raw ?? null)
  };
}

function createSelectFieldType(input: {
  defaultConfig: JsonValue;
  multiValue: boolean;
  sampleInput: unknown;
  type: "select.single" | "select.multi" | "status.semantic";
}): FieldTypeDefinition {
  const supportedConditionOperators = input.multiValue
    ? ["select_has_option", "is_empty", "is_not_empty"]
    : ["equals", "not_equals", "is_empty", "is_not_empty"];
  const supportedSortModes = ["ascending", "descending"];
  const permissionBehavior = {
    ...basePermissionBehavior
  };
  const sampleNormalized = input.multiValue
    ? normalizeConfiguredMultiSelectValue(input.type, input.sampleInput, input.defaultConfig)
    : normalizeConfiguredSelectValue(input.type, input.sampleInput, input.defaultConfig);
  const sampleIndex = buildConfiguredSelectIndex(sampleNormalized.value, input.defaultConfig, {
    multiValue: input.multiValue,
    sortByOptionOrder: !input.multiValue
  });

  return {
    type: input.type,
    version: 1,
    capabilities: {
      ...baseCapabilities,
      multiValue: input.multiValue,
      scalar: !input.multiValue,
      supportsGrouping: input.type !== "select.multi"
    },
    configSchema: {
      type: "object",
      description:
        input.type === "status.semantic"
          ? "Status option configuration with semantic states."
          : "Select option configuration."
    },
    valueSchema: input.multiValue
      ? {
          type: "array",
          description: "Configured multi-select option ids."
        }
      : {
          type: "string",
          description: "Configured select option id."
        },
    defaultConfig: input.defaultConfig,
    supportedConditionOperators,
    supportedSortModes,
    normalize(rawInput, context) {
      return input.multiValue
        ? normalizeConfiguredMultiSelectValue(input.type, rawInput, context.fieldConfig)
        : normalizeConfiguredSelectValue(input.type, rawInput, context.fieldConfig);
    },
    validateConfig(config) {
      return validateSelectConfig(config, {
        requireSemantic: input.type === "status.semantic",
        type: input.type
      });
    },
    validateValue(value, context) {
      return validateConfiguredSelectValue(input.type, value, context.fieldConfig, {
        multiValue: input.multiValue
      });
    },
    applyDefault() {
      return null;
    },
    toDisplay(value, context) {
      return buildConfiguredSelectIndex(value, context.fieldConfig, {
        multiValue: input.multiValue,
        sortByOptionOrder: !input.multiValue
      }).displayValue;
    },
    toIndex(value, context) {
      return buildConfiguredSelectIndex(value, context.fieldConfig, {
        multiValue: input.multiValue,
        sortByOptionOrder: !input.multiValue
      });
    },
    toSearchText(value, context) {
      return buildConfiguredSelectIndex(value, context.fieldConfig, {
        multiValue: input.multiValue,
        sortByOptionOrder: !input.multiValue
      }).searchText;
    },
    getSupportedConditionOperators() {
      return supportedConditionOperators;
    },
    getSupportedSortModes() {
      return supportedSortModes;
    },
    getPermissionBehavior() {
      return permissionBehavior;
    },
    fixtures: [
      {
        id: `${input.type}.normalize.sample`,
        kind: "normalize",
        input: input.sampleInput,
        expected: {
          value: sampleNormalized.value,
          warnings: sampleNormalized.warnings,
          display: sampleIndex.displayValue,
          searchText: sampleIndex.searchText,
          index: sampleIndex
        }
      },
      {
        id: `${input.type}.operators.sample`,
        kind: "operators",
        expectedConditionOperators: supportedConditionOperators,
        expectedSortModes: supportedSortModes
      },
      {
        id: `${input.type}.permission.sample`,
        kind: "permission",
        expected: permissionBehavior
      }
    ]
  };
}

function normalizeTextValue(type: string, input: unknown): NormalizeResult {
  const raw = coerceScalarText(input);

  return {
    value: buildNormalizedValue(type, raw, 1, {
      tokens: normalizeTextTokens(raw)
    }),
    warnings: []
  };
}

function normalizeNumberValue(type: string, input: unknown): NormalizeResult {
  const rawInput = coerceScalarText(input);

  if (rawInput === "") {
    return {
      value: buildNormalizedValue(type, null),
      warnings: []
    };
  }

  const parsed = Number(rawInput);

  if (Number.isNaN(parsed)) {
    return {
      value: buildNormalizedValue(type, null),
      warnings: [
        {
          code: "number.invalid",
          message: `Could not normalize "${rawInput}" as a decimal number.`
        }
      ]
    };
  }

  return {
    value: buildNormalizedValue(type, String(parsed)),
    warnings: []
  };
}

function normalizeBooleanValue(type: string, input: unknown): NormalizeResult {
  return {
    value: buildNormalizedValue(type, Boolean(input)),
    warnings: []
  };
}

function normalizeScalarSelectValue(type: string, input: unknown): NormalizeResult {
  const raw = coerceScalarText(input);

  return {
    value: buildNormalizedValue(type, raw),
    warnings: []
  };
}

function normalizeMultiSelectValue(type: string, input: unknown): NormalizeResult {
  const values = Array.isArray(input) ? input : [input];
  const raw = values
    .map((value) => coerceScalarText(value))
    .filter((value) => value !== "");
  const canonical = Array.from(new Set(raw)).sort();

  return {
    value: buildNormalizedValue(type, canonical, 1, {
      tokens: canonical.map((value) => value.toLowerCase())
    }),
    warnings: raw.length === canonical.length
      ? []
      : [
          {
            code: "select.duplicate_option",
            message: "Duplicate options were removed during normalization."
          }
        ]
  };
}

function normalizeDateValue(type: string, input: unknown): NormalizeResult {
  const raw = coerceScalarText(input);

  return {
    value: buildNormalizedValue(type, raw),
    warnings: []
  };
}

function normalizeReferenceValue(type: string, input: unknown): NormalizeResult {
  const values = Array.isArray(input) ? input : [input];
  const refs = values
    .map((value) => coerceScalarText(value))
    .filter((value) => value !== "");
  const canonical = Array.from(new Set(refs)).sort();

  return {
    value: buildNormalizedValue(type, canonical, 1, {
      refs: canonical
    }),
    warnings: refs.length === canonical.length
      ? []
      : [
          {
            code: "reference.duplicate_ref",
            message: "Duplicate references were removed during normalization."
          }
        ]
  };
}

function normalizeOpaqueValue(type: string, input: unknown): NormalizeResult {
  const raw =
    input == null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean" ||
    Array.isArray(input) ||
    typeof input === "object"
      ? (input as JsonValue)
      : String(input);

  return {
    value: buildNormalizedValue(type, raw),
    warnings: []
  };
}

export const mvpFieldTypes: FieldTypeDefinition[] = [
  defineFieldType({
    type: "text.single_line",
    sampleInput: "Alpha Bravo",
    normalizeSample: (input) => normalizeTextValue("text.single_line", input),
    indexSample: buildTextIndex
  }),
  defineFieldType({
    type: "text.long",
    sampleInput: "Alpha Bravo Charlie",
    normalizeSample: (input) => normalizeTextValue("text.long", input),
    indexSample: buildTextIndex
  }),
  defineFieldType({
    type: "number.decimal",
    valueSchema: { type: "number", description: "Decimal-like scalar input." },
    supportedConditionOperators: ["equals", "not_equals", "number_compare"],
    sampleInput: "42.5",
    normalizeSample: (input) => normalizeNumberValue("number.decimal", input),
    indexSample: buildNumberIndex
  }),
  defineFieldType({
    type: "boolean.checkbox",
    valueSchema: { type: "boolean", description: "Checkbox boolean input." },
    supportedSortModes: ["false_first", "true_first"],
    sampleInput: true,
    normalizeSample: (input) => normalizeBooleanValue("boolean.checkbox", input),
    indexSample: buildBooleanIndex
  }),
  createSelectFieldType({
    type: "select.single",
    sampleInput: "ready",
    defaultConfig: {
      options: [
        { id: "backlog", label: "Backlog" },
        { id: "ready", label: "Ready" },
        { id: "done", label: "Done" }
      ]
    },
    multiValue: false
  }),
  createSelectFieldType({
    type: "select.multi",
    sampleInput: ["beta", "alpha", "alpha"],
    defaultConfig: {
      options: [
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
        { id: "gamma", label: "Gamma" }
      ]
    },
    multiValue: true
  }),
  defineFieldType({
    type: "date.date",
    supportedConditionOperators: ["equals", "not_equals", "date_compare"],
    sampleInput: "2026-06-06",
    normalizeSample: (input) => normalizeDateValue("date.date", input),
    indexSample: buildDateIndex
  }),
  defineFieldType({
    type: "date.datetime",
    supportedConditionOperators: ["equals", "not_equals", "date_compare"],
    sampleInput: "2026-06-06T00:00:00.000Z",
    normalizeSample: (input) => normalizeDateValue("date.datetime", input),
    indexSample: buildDateIndex
  }),
  defineFieldType({
    type: "principal.user",
    capabilities: {
      reference: true
    },
    valueSchema: { type: "array", description: "User reference ids." },
    sampleInput: ["user_002", "user_001"],
    normalizeSample: (input) => normalizeReferenceValue("principal.user", input),
    indexSample: buildReferenceIndex
  }),
  defineFieldType({
    type: "relation.record",
    capabilities: {
      scalar: false,
      multiValue: true,
      reference: true
    },
    valueSchema: { type: "array", description: "Record reference ids." },
    supportedConditionOperators: ["relation_contains_record", "is_empty", "is_not_empty"],
    sampleInput: ["rec_002", "rec_001"],
    normalizeSample: (input) => normalizeReferenceValue("relation.record", input),
    indexSample: buildReferenceIndex
  }),
  defineFieldType({
    type: "computed.readonly",
    capabilities: {
      computed: true,
      userEditable: false,
      supportsDefaultValue: false,
      supportsAgentMutation: false
    },
    permissionBehavior: {
      allowsMutation: false
    },
    sampleInput: "derived-value",
    normalizeSample: (input) => normalizeOpaqueValue("computed.readonly", input),
    indexSample: buildTextIndex
  }),
  createSelectFieldType({
    type: "status.semantic",
    sampleInput: "in_progress",
    defaultConfig: {
      options: [
        { id: "todo", label: "Todo", semantic: "todo" },
        { id: "in_progress", label: "In Progress", semantic: "in_progress" },
        { id: "blocked", label: "Blocked", semantic: "blocked" },
        { id: "done", label: "Done", semantic: "done" }
      ]
    },
    multiValue: false
  })
];
