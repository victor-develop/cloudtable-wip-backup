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
  defineFieldType({
    type: "select.single",
    sampleInput: "ready",
    normalizeSample: (input) => normalizeScalarSelectValue("select.single", input),
    indexSample: buildTextIndex
  }),
  defineFieldType({
    type: "select.multi",
    capabilities: {
      scalar: false,
      multiValue: true
    },
    valueSchema: {
      type: "array",
      description: "Multi-select option ids."
    },
    supportedConditionOperators: ["select_has_option", "is_empty", "is_not_empty"],
    sampleInput: ["beta", "alpha", "alpha"],
    normalizeSample: (input) => normalizeMultiSelectValue("select.multi", input),
    indexSample(value) {
      const raw = Array.isArray(value?.raw) ? value.raw.join(",") : "";

      return {
        textValue: raw === "" ? null : raw,
        displayValue: raw.replaceAll(",", ", "),
        searchText: raw.toLowerCase().replaceAll(",", " "),
        valueHash: stableHash(value?.raw ?? null)
      };
    }
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
  defineFieldType({
    type: "status.semantic",
    sampleInput: "green",
    normalizeSample: (input) => normalizeScalarSelectValue("status.semantic", input),
    indexSample: buildTextIndex
  })
];
