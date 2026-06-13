import type {
  CellValidationContext,
  FieldWorkflowBindingAlias,
  FieldWorkflowProposalHint,
  FieldSchemaContext,
  FieldIndexValue,
  FieldPermissionBehavior,
  FieldTypeCapabilities,
  FieldTypeDefinition,
  FieldTypeFixture,
  JsonSchema,
  JsonValue,
  NormalizedCellValue,
  NormalizeResult,
  ValidationResult
} from "./types";
import { listPrincipalUserCanonicalBindings } from "../ownership/row-owner";

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

const defaultWorkflowProposalHints: readonly FieldWorkflowProposalHint[] = [
  {
    operatorId: "is_empty",
    matchPhrases: ["missing", "empty", "blank", "not set", "unset"],
    matchFieldPhrases: ["without {field}", "{field} missing"]
  },
  {
    operatorId: "is_not_empty",
    matchPhrases: ["present", "populated", "filled", "has value", "is set", "set"]
  }
];

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
  normalize?: (input: unknown) => NormalizeResult;
  normalizeSample: (input: unknown) => NormalizeResult;
  validateConfig?: (config: unknown, context: FieldSchemaContext) => ValidationResult;
  validateValue?: (
    value: NormalizedCellValue | null,
    context: CellValidationContext
  ) => ValidationResult;
  invalidConfigFixtures?: ReadonlyArray<{
    idSuffix: string;
    config: unknown;
    expectedErrors: readonly string[];
  }>;
  invalidValueFixtures?: ReadonlyArray<
    | {
        idSuffix: string;
        fieldConfig?: JsonValue;
        input: unknown;
        expected: {
          value: NormalizedCellValue | null;
          warnings?: readonly { code: string; message: string }[];
          errors: readonly string[];
        };
      }
    | {
        idSuffix: string;
        fieldConfig?: JsonValue;
        value: NormalizedCellValue | null;
        expected: {
          errors: readonly string[];
        };
      }
  >;
  indexSample: (value: NormalizedCellValue | null) => FieldIndexValue;
  workflowProposalHints?:
    | readonly FieldWorkflowProposalHint[]
    | ((
        context: {
          aliasOf?: string;
          binding: string;
          bindingKind: "field" | "alias";
          fieldConfig?: JsonValue;
          isCanonical?: boolean;
        }
      ) => readonly FieldWorkflowProposalHint[]);
  workflowBindingAliases?:
    | readonly FieldWorkflowBindingAlias[]
    | ((context: { fieldConfig?: JsonValue; fieldType: string }) => readonly FieldWorkflowBindingAlias[]);
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

const decimalPattern = /^-?\d+(?:\.\d+)?$/;
const datetimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const booleanSentinel = Symbol("invalid-boolean");

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
      return input.normalize?.(rawInput) ?? input.normalizeSample(rawInput);
    },
    validateConfig(config, context) {
      return (
        input.validateConfig?.(config, context) ?? {
          valid: typeof config === "object" && config !== null,
          errors:
            typeof config === "object" && config !== null
              ? []
              : ["Field configuration must be an object."]
        }
      );
    },
    validateValue(value, context) {
      return (
        input.validateValue?.(value, context) ?? {
          valid: value == null || value.valueType === input.type,
          errors:
            value == null || value.valueType === input.type
              ? []
              : [`Expected ${input.type} value, received ${value.valueType}.`]
        }
      );
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
    getWorkflowBindingAliases(context) {
      const aliases =
        typeof input.workflowBindingAliases === "function"
          ? input.workflowBindingAliases(context)
          : input.workflowBindingAliases ?? [];

      return aliases.map((alias) => ({ ...alias }));
    },
    getWorkflowProposalHints(context) {
      const hints =
        typeof input.workflowProposalHints === "function"
          ? input.workflowProposalHints(context)
          : input.workflowProposalHints ?? defaultWorkflowProposalHints;

      return hints.map(cloneProposalHint);
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
      },
      ...(input.invalidConfigFixtures ?? []).map((fixture) => ({
        id: `${input.type}.invalid_config.${fixture.idSuffix}`,
        kind: "invalid_config" as const,
        config: fixture.config,
        expectedErrors: fixture.expectedErrors
      })),
      ...(input.invalidValueFixtures ?? []).map((fixture) =>
        buildInvalidValueFixture(input.type, fixture)
      )
    ]
  };
}

function buildInvalidValueFixture(
  type: string,
  fixture: NonNullable<ModuleFixtureInput["invalidValueFixtures"]>[number]
): FieldTypeFixture {
  if ("input" in fixture) {
    return {
      id: `${type}.invalid_value.${fixture.idSuffix}`,
      kind: "invalid_value",
      fieldConfig: fixture.fieldConfig,
      input: fixture.input,
      expected: fixture.expected
    };
  }

  return {
    id: `${type}.invalid_value.${fixture.idSuffix}`,
    kind: "invalid_value",
    fieldConfig: fixture.fieldConfig,
    value: fixture.value,
    expected: fixture.expected
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

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

function unexpectedConfigKeys(
  config: Record<string, unknown>,
  allowedKeys: readonly string[]
): string[] {
  return Object.keys(config)
    .filter((key) => !allowedKeys.includes(key))
    .sort()
    .map((key) => `Field configuration contains unsupported property: ${key}.`);
}

function validateObjectConfig(
  config: unknown,
  allowedKeys: readonly string[]
): { config: Record<string, unknown> | null; errors: string[]; valid: boolean } {
  if (!isRecord(config)) {
    return {
      config: null,
      valid: false,
      errors: ["Field configuration must be an object."]
    };
  }

  const errors = [...unexpectedConfigKeys(config, allowedKeys)];

  return {
    config,
    valid: errors.length === 0,
    errors
  };
}

function validateStringArray(
  value: unknown,
  label: string
): {
  valid: boolean;
  errors: string[];
} {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      errors: [`${label} must be an array.`]
    };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`${label} entry ${index} must be a non-empty string.`);
      continue;
    }

    const normalized = entry.trim();
    if (seen.has(normalized)) {
      errors.push(`${label} entries must be unique: ${normalized}.`);
      continue;
    }

    seen.add(normalized);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function canonicalizeDecimalString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!decimalPattern.test(trimmed)) {
    return null;
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fractionPart.replace(/0+$/, "");
  const canonical =
    normalizedFraction === ""
      ? normalizedInteger
      : `${normalizedInteger}.${normalizedFraction}`;

  if (canonical === "0") {
    return "0";
  }

  return negative ? `-${canonical}` : canonical;
}

function parseConfiguredNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const canonical = canonicalizeDecimalString(value);
    return canonical == null ? null : Number(canonical);
  }

  return null;
}

function fractionDigits(raw: string): number {
  const [, fraction = ""] = raw.split(".");
  return fraction.length;
}

function parseBooleanInput(input: unknown): boolean | null | typeof booleanSentinel {
  if (input == null) {
    return null;
  }

  if (typeof input === "boolean") {
    return input;
  }

  if (typeof input === "number") {
    if (input === 1) {
      return true;
    }
    if (input === 0) {
      return false;
    }
    return booleanSentinel;
  }

  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "") {
      return null;
    }
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return booleanSentinel;
}

function isValidDateOnly(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return false;
  }

  const date = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

function normalizeReferenceIds(input: unknown): {
  canonical: string[];
} {
  const values = Array.isArray(input) ? input : [input];
  const canonical = values
    .map((value) => coerceScalarText(value))
    .filter((value) => value !== "")
    .sort();

  return {
    canonical
  };
}

function buildComputedDisplayValue(raw: JsonValue | null): string {
  if (raw == null) {
    return "";
  }

  if (typeof raw === "string") {
    return raw;
  }

  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }

  return JSON.stringify(raw);
}

function buildOpaqueIndex(value: NormalizedCellValue | null): FieldIndexValue {
  const raw = value?.raw ?? null;
  const displayValue = buildComputedDisplayValue(raw);
  const searchText = normalizeTextTokens(displayValue).join(" ");

  return {
    textValue: displayValue === "" ? null : displayValue,
    displayValue,
    searchText,
    valueHash: stableHash(raw)
  };
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
  const { config: parsedConfig, errors } = validateObjectConfig(config, ["options"]);
  if (!parsedConfig) {
    return {
      valid: false,
      errors
    };
  }

  if (parsedConfig.options === undefined) {
    return {
      valid: errors.length === 0,
      errors
    };
  }

  if (!Array.isArray(parsedConfig.options)) {
    return {
      valid: false,
      errors: [...errors, "Field configuration options must be an array."]
    };
  }

  const seenIds = new Set<string>();
  for (const [index, rawOption] of parsedConfig.options.entries()) {
    if (!isRecord(rawOption)) {
      errors.push(`Field option ${index} must be an object.`);
      continue;
    }

    errors.push(
      ...unexpectedConfigKeys(rawOption, ["id", "label", "color", "description", "semantic"])
        .sort()
        .map((message) =>
          message.replace(
            "Field configuration contains unsupported property:",
            `Field option ${index} contains unsupported property:`
          )
        )
    );

    const id =
      typeof rawOption.id === "string" && rawOption.id.trim() !== "" ? rawOption.id.trim() : null;
    const label =
      typeof rawOption.label === "string" && rawOption.label.trim() !== ""
        ? rawOption.label.trim()
        : null;
    if (id == null) {
      errors.push(`Field option ${index} id must be a non-empty string.`);
    }
    if (label == null) {
      errors.push(`Field option ${index} label must be a non-empty string.`);
    }
    if (id != null && seenIds.has(id)) {
      errors.push(`Field option ids must be unique: ${id}.`);
    }
    if (id != null) {
      seenIds.add(id);
    }

    if (
      rawOption.color !== undefined &&
      (typeof rawOption.color !== "string" || rawOption.color.trim() === "")
    ) {
      errors.push(`Field option ${id ?? index} color must be a non-empty string when provided.`);
    }
    if (
      rawOption.description !== undefined &&
      (typeof rawOption.description !== "string" || rawOption.description.trim() === "")
    ) {
      errors.push(
        `Field option ${id ?? index} description must be a non-empty string when provided.`
      );
    }

    if (options.requireSemantic) {
      if (rawOption.semantic === undefined) {
        errors.push(`Status option ${id || index} is missing a semantic value.`);
      } else if (
        typeof rawOption.semantic !== "string" ||
        rawOption.semantic.trim() === ""
      ) {
        errors.push(`Status option ${id ?? index} semantic must be a non-empty string.`);
      } else if (
        !statusSemantics.includes(rawOption.semantic.trim() as (typeof statusSemantics)[number])
      ) {
        errors.push(
          `Status option ${id ?? index} has unsupported semantic: ${rawOption.semantic.trim()}.`
        );
      }
    } else if (
      rawOption.semantic !== undefined &&
      (typeof rawOption.semantic !== "string" || rawOption.semantic.trim() === "")
    ) {
      errors.push(
        `Field option ${id ?? index} semantic must be a non-empty string when provided.`
      );
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

function buildOptionPhraseVariants(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return [];
  }

  return Array.from(
    new Set([
      trimmed.toLowerCase(),
      trimmed
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase()
    ])
  ).filter((entry) => entry.length > 0);
}

function buildConfiguredOptionWorkflowProposalHints(
  options: readonly SelectOption[]
): FieldWorkflowProposalHint[] {
  const semanticCounts = new Map<string, number>();
  for (const option of options) {
    if (!option.semantic) {
      continue;
    }

    semanticCounts.set(option.semantic, (semanticCounts.get(option.semantic) ?? 0) + 1);
  }

  return options.map((option) => {
    const optionPhrases = new Set<string>([
      ...buildOptionPhraseVariants(option.id),
      ...buildOptionPhraseVariants(option.label)
    ]);
    if (option.semantic && semanticCounts.get(option.semantic) === 1) {
      for (const phrase of buildOptionPhraseVariants(option.semantic)) {
        optionPhrases.add(phrase);
      }
    }

    const contextualPhrases = Array.from(optionPhrases).flatMap((phrase) => [
      `changes to ${phrase}`,
      `becomes ${phrase}`,
      `is ${phrase}`,
      `set to ${phrase}`,
      `equals ${phrase}`
    ]);

    return {
      draftInput: {
        left: {
          path: "row.fields.{field}.value"
        },
        right: option.id
      },
      matchFieldPhrases: [
        "{field} changes to " + option.label,
        "{field} becomes " + option.label,
        "{field} is " + option.label,
        "{field} set to " + option.label,
        "{field} equals " + option.label
      ],
      matchPhrases: contextualPhrases,
      operatorId: "equals"
    };
  });
}

function buildNumberComparisonWorkflowProposalHints(binding: string): FieldWorkflowProposalHint[] {
  const comparisons: ReadonlyArray<{
    comparator: string;
    fieldPhrases: readonly string[];
    phrases: readonly string[];
  }> = [
    {
      comparator: "gt",
      fieldPhrases: ["{field} greater than", "{field} is greater than", "{field} more than", "{field} above"],
      phrases: ["greater than", "more than", "above", "over"]
    },
    {
      comparator: "gte",
      fieldPhrases: ["{field} at least", "{field} is at least", "{field} no less than"],
      phrases: ["at least", "no less than", "greater than or equal to"]
    },
    {
      comparator: "lt",
      fieldPhrases: ["{field} less than", "{field} is less than", "{field} under", "{field} below"],
      phrases: ["less than", "under", "below"]
    },
    {
      comparator: "lte",
      fieldPhrases: ["{field} at most", "{field} is at most", "{field} no more than"],
      phrases: ["at most", "no more than", "less than or equal to"]
    }
  ];

  return comparisons.map((comparison) => ({
    draftInput: {
      comparator: comparison.comparator,
      left: {
        path: `${binding}.value`
      },
      right: null
    },
    matchFieldPhrases: [...comparison.fieldPhrases],
    matchPhrases: [...comparison.phrases],
    operatorId: "number_compare"
  }));
}

function buildBooleanEqualityWorkflowProposalHints(binding: string): FieldWorkflowProposalHint[] {
  return [
    {
      draftInput: {
        left: {
          path: `${binding}.value`
        },
        right: false
      },
      matchFieldPhrases: [
        "{field} is unchecked",
        "{field} unchecked",
        "{field} is not checked",
        "{field} not checked",
        "{field} is false"
      ],
      matchPhrases: ["is unchecked", "unchecked", "is not checked", "not checked", "is false"],
      operatorId: "equals"
    },
    {
      draftInput: {
        left: {
          path: `${binding}.value`
        },
        right: true
      },
      matchFieldPhrases: [
        "{field} is checked",
        "{field} checked",
        "{field} is true"
      ],
      matchPhrases: ["is checked", "checked", "is true"],
      operatorId: "equals"
    }
  ];
}

function buildDateComparisonWorkflowProposalHints(binding: string): FieldWorkflowProposalHint[] {
  const comparisons: ReadonlyArray<{
    comparator: string;
    fieldPhrases: readonly string[];
    phrases: readonly string[];
  }> = [
    {
      comparator: "on_or_before",
      fieldPhrases: ["{field} on or before", "{field} is on or before", "{field} no later than"],
      phrases: ["on or before", "no later than"]
    },
    {
      comparator: "before",
      fieldPhrases: ["{field} before", "{field} is before", "{field} earlier than"],
      phrases: ["before", "earlier than"]
    },
    {
      comparator: "on_or_after",
      fieldPhrases: ["{field} on or after", "{field} is on or after", "{field} no earlier than"],
      phrases: ["on or after", "no earlier than"]
    },
    {
      comparator: "after",
      fieldPhrases: ["{field} after", "{field} is after", "{field} later than"],
      phrases: ["after", "later than"]
    }
  ];

  return comparisons.map((comparison) => ({
    draftInput: {
      comparator: comparison.comparator,
      left: {
        path: `${binding}.value`
      },
      right: null
    },
    matchFieldPhrases: [...comparison.fieldPhrases],
    matchPhrases: [...comparison.phrases],
    operatorId: "date_compare"
  }));
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

function cloneProposalHint(hint: FieldWorkflowProposalHint): FieldWorkflowProposalHint {
  return {
    draftInput:
      hint.draftInput === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(hint.draftInput)) as Record<string, JsonValue>),
    matchFieldPhrases: hint.matchFieldPhrases ? [...hint.matchFieldPhrases] : undefined,
    matchPhrases: [...hint.matchPhrases],
    operatorId: hint.operatorId
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

  const structuralErrors: string[] = [];
  const rawIds = options.multiValue
    ? Array.isArray(value.raw)
      ? value.raw.flatMap((entry, index) => {
          if (typeof entry !== "string" || entry.trim() === "") {
            structuralErrors.push(
              `Expected ${type} value entry ${index} to be a non-empty option id.`
            );
            return [];
          }
          return [entry.trim()];
        })
      : []
    : typeof value.raw === "string"
      ? value.raw === ""
        ? []
        : [value.raw]
      : [];

  if (options.multiValue) {
    const seen = new Set<string>();
    for (const id of rawIds) {
      if (seen.has(id)) {
        structuralErrors.push(`Expected ${type} value entries to be unique: ${id}.`);
        continue;
      }
      seen.add(id);
    }
  }

  const parsedConfig = parseSelectConfig(config);
  if (!parsedConfig.hasOptions) {
    return {
      valid: structuralErrors.length === 0,
      errors: structuralErrors
    };
  }

  const unknownIds = rawIds.filter((id) => !parsedConfig.optionsById.has(id));

  return {
    valid: structuralErrors.length === 0 && unknownIds.length === 0,
    errors: [
      ...structuralErrors,
      ...unknownIds.map((id) => `Unknown option id for ${type}: ${id}.`)
    ]
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
  const requireSemantic = input.type === "status.semantic";
  const invalidConfigFixtures = [
    {
      idSuffix: "malformed_option_payload",
      config: {
        options: [
          {
            id: 42,
            label: "Ready",
            extra: true
          },
          {
            id: "ready",
            label: ""
          },
          {
            id: "ready",
            label: "Duplicate"
          }
        ]
      },
      expectedErrors: requireSemantic
        ? [
            "Field option 0 contains unsupported property: extra.",
            "Field option 0 id must be a non-empty string.",
            "Status option 0 is missing a semantic value.",
            "Field option 1 label must be a non-empty string.",
            "Status option ready is missing a semantic value.",
            "Field option ids must be unique: ready.",
            "Status option ready is missing a semantic value."
          ]
        : [
            "Field option 0 contains unsupported property: extra.",
            "Field option 0 id must be a non-empty string.",
            "Field option 1 label must be a non-empty string.",
            "Field option ids must be unique: ready."
          ]
    },
    ...(requireSemantic
      ? [
          {
            idSuffix: "invalid_semantics",
            config: {
              options: [
                {
                  id: "todo",
                  label: "Todo"
                },
                {
                  id: "doing",
                  label: "Doing",
                  semantic: "moving"
                }
              ]
            },
            expectedErrors: [
              "Status option todo is missing a semantic value.",
              "Status option doing has unsupported semantic: moving."
            ]
          }
        ]
      : [])
  ];
  const invalidValueFixtures = [
    {
      idSuffix: "unknown_option_id",
      fieldConfig: input.defaultConfig,
      input: input.multiValue ? ["beta", "missing"] : "missing",
      expected: {
        value: input.multiValue
          ? buildNormalizedValue(input.type, ["beta", "missing"], 1, {
              tokens: ["beta", "missing"]
            })
          : buildNormalizedValue(input.type, "missing", 1, {
              tokens: ["missing"]
            }),
        warnings: [],
        errors: [`Unknown option id for ${input.type}: missing.`]
      }
    },
    ...(input.multiValue
      ? [
          {
            idSuffix: "duplicate_entries",
            fieldConfig: input.defaultConfig,
            value: buildNormalizedValue(input.type, ["alpha", "alpha"], 1, {
              tokens: ["alpha", "alpha"]
            }),
            expected: {
              errors: ["Expected select.multi value entries to be unique: alpha."]
            }
          }
        ]
      : [])
  ];

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
          : "Select option configuration.",
      additionalProperties: false,
      properties: {
        options: {
          type: "array",
          description: "Ordered option definitions.",
          items: {
            type: "object",
            description:
              input.type === "status.semantic"
                ? "Status option with required semantic meaning."
                : "Selectable option definition."
          }
        }
      }
    },
    valueSchema: input.multiValue
      ? {
          type: "array",
          description: "Configured multi-select option ids.",
          items: {
            type: "string",
            description: "Canonical option id."
          }
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
        requireSemantic,
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
    getWorkflowBindingAliases() {
      return [];
    },
    getWorkflowProposalHints(context) {
      const parsedConfig = parseSelectConfig(context.fieldConfig);
      const configuredOptionHints =
        input.type === "status.semantic"
          ? buildConfiguredOptionWorkflowProposalHints(parsedConfig.options).map((hint) => ({
              ...hint,
              draftInput: {
                left: {
                  path: `${context.binding}.value`
                },
                right: hint.draftInput?.right ?? null
              }
            }))
          : [];

      return [...configuredOptionHints, ...defaultWorkflowProposalHints].map(cloneProposalHint);
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
      },
      ...invalidConfigFixtures.map((fixture) => ({
        id: `${input.type}.invalid_config.${fixture.idSuffix}`,
        kind: "invalid_config" as const,
        config: fixture.config,
        expectedErrors: fixture.expectedErrors
      })),
      ...invalidValueFixtures.map((fixture) => buildInvalidValueFixture(input.type, fixture))
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

function validateTextConfig(config: unknown): ValidationResult {
  const { errors } = validateObjectConfig(config, []);

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateTextValue(type: string, value: NormalizedCellValue | null): ValidationResult {
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

  if (value.raw != null && typeof value.raw !== "string") {
    return {
      valid: false,
      errors: [`Expected ${type} value to be a string or null.`]
    };
  }

  if (
    value.tokens !== undefined &&
    (!Array.isArray(value.tokens) ||
      value.tokens.some((token) => typeof token !== "string" || token.trim() === ""))
  ) {
    return {
      valid: false,
      errors: [`Expected ${type} tokens to contain non-empty normalized strings.`]
    };
  }

  return {
    valid: true,
    errors: []
  };
}

function normalizeNumberValue(type: string, input: unknown): NormalizeResult {
  if (input == null || (typeof input === "string" && input.trim() === "")) {
    return {
      value: buildNormalizedValue(type, null),
      warnings: []
    };
  }

  const rawInput = typeof input === "number" ? String(input) : coerceScalarText(input);
  const canonical = canonicalizeDecimalString(rawInput);

  if (canonical == null) {
    return {
      value: buildNormalizedValue(type, rawInput),
      warnings: [
        {
          code: "number.invalid",
          message: `Could not normalize "${rawInput}" as a decimal number.`
        }
      ]
    };
  }

  return {
    value: buildNormalizedValue(type, canonical),
    warnings: []
  };
}

function normalizeBooleanValue(type: string, input: unknown): NormalizeResult {
  const parsed = parseBooleanInput(input);
  if (parsed === booleanSentinel) {
    const rawInput = coerceScalarText(input);

    return {
      value: buildNormalizedValue(type, rawInput),
      warnings: [
        {
          code: "boolean.invalid",
          message: `Could not normalize "${rawInput}" as a boolean value.`
        }
      ]
    };
  }

  return {
    value: buildNormalizedValue(type, parsed),
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

function normalizeDateValue(
  type: "date.date" | "date.datetime",
  input: unknown
): NormalizeResult {
  if (input == null || (typeof input === "string" && input.trim() === "")) {
    return {
      value: buildNormalizedValue(type, null),
      warnings: []
    };
  }

  if (type === "date.date") {
    const raw = coerceScalarText(input);

    return isValidDateOnly(raw)
      ? {
          value: buildNormalizedValue(type, raw),
          warnings: []
        }
      : {
          value: buildNormalizedValue(type, raw),
          warnings: [
            {
              code: "date.invalid",
              message: `Could not normalize "${raw}" as an ISO date.`
            }
          ]
        };
  }

  const rawInput =
    input instanceof Date && !Number.isNaN(input.getTime())
      ? input.toISOString()
      : coerceScalarText(input);

  if (datetimePattern.test(rawInput)) {
    const parsed = new Date(rawInput);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        value: buildNormalizedValue(type, parsed.toISOString()),
        warnings: []
      };
    }
  }

  return {
    value: buildNormalizedValue(type, rawInput),
    warnings: [
      {
        code: "datetime.invalid",
        message: `Could not normalize "${rawInput}" as an ISO datetime.`
      }
    ]
  };
}

function normalizeReferenceValue(type: string, input: unknown): NormalizeResult {
  const { canonical } = normalizeReferenceIds(input);

  return {
    value: buildNormalizedValue(type, canonical, 1, {
      refs: canonical
    }),
    warnings: []
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
    value: buildNormalizedValue(type, raw, 1, {
      tokens: normalizeTextTokens(buildComputedDisplayValue(raw))
    }),
    warnings: []
  };
}

function validateNumberConfig(config: unknown): ValidationResult {
  const { config: parsedConfig, errors } = validateObjectConfig(config, [
    "display",
    "integerOnly",
    "max",
    "min",
    "precision"
  ]);
  if (!parsedConfig) {
    return {
      valid: false,
      errors
    };
  }

  if (
    parsedConfig.integerOnly !== undefined &&
    typeof parsedConfig.integerOnly !== "boolean"
  ) {
    errors.push("Field configuration integerOnly must be a boolean.");
  }

  if (parsedConfig.precision !== undefined) {
    if (
      typeof parsedConfig.precision !== "number" ||
      !Number.isInteger(parsedConfig.precision) ||
      parsedConfig.precision < 0
    ) {
      errors.push("Field configuration precision must be a non-negative integer.");
    }
  }

  const min = parsedConfig.min === undefined ? null : parseConfiguredNumber(parsedConfig.min);
  const max = parsedConfig.max === undefined ? null : parseConfiguredNumber(parsedConfig.max);
  if (parsedConfig.min !== undefined && min == null) {
    errors.push("Field configuration min must be a finite decimal number.");
  }
  if (parsedConfig.max !== undefined && max == null) {
    errors.push("Field configuration max must be a finite decimal number.");
  }
  if (min != null && max != null && min > max) {
    errors.push("Field configuration min cannot be greater than max.");
  }

  if (parsedConfig.display !== undefined) {
    if (
      typeof parsedConfig.display !== "string" ||
      !["plain", "currency", "percent"].includes(parsedConfig.display)
    ) {
      errors.push(
        "Field configuration display must be one of: plain, currency, percent."
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateNumberValue(
  type: string,
  value: NormalizedCellValue | null,
  config: unknown
): ValidationResult {
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

  if (value.raw === null) {
    return {
      valid: true,
      errors: []
    };
  }

  if (typeof value.raw !== "string") {
    return {
      valid: false,
      errors: [`Expected ${type} value to be a canonical decimal string.`]
    };
  }

  const canonical = canonicalizeDecimalString(value.raw);
  if (canonical == null || canonical !== value.raw) {
    return {
      valid: false,
      errors: [`Expected ${type} value to be a canonical decimal string.`]
    };
  }

  const numericValue = Number(canonical);
  const parsedConfig = isRecord(config) ? config : {};
  const errors: string[] = [];
  if (parsedConfig.integerOnly === true && !Number.isInteger(numericValue)) {
    errors.push(`Expected ${type} value to be an integer.`);
  }
  if (
    typeof parsedConfig.precision === "number" &&
    fractionDigits(canonical) > parsedConfig.precision
  ) {
    errors.push(
      `Expected ${type} value to use at most ${parsedConfig.precision} decimal places.`
    );
  }

  const min = parseConfiguredNumber(parsedConfig.min);
  const max = parseConfiguredNumber(parsedConfig.max);
  if (min != null && numericValue < min) {
    errors.push(`Expected ${type} value to be greater than or equal to ${min}.`);
  }
  if (max != null && numericValue > max) {
    errors.push(`Expected ${type} value to be less than or equal to ${max}.`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateStrictObjectConfig(
  config: unknown,
  allowedKeys: readonly string[]
): ValidationResult {
  const { config: parsedConfig, errors } = validateObjectConfig(config, allowedKeys);

  return {
    valid: parsedConfig != null && errors.length === 0,
    errors
  };
}

function validateBooleanValue(type: string, value: NormalizedCellValue | null): ValidationResult {
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

  return {
    valid: value.raw === null || typeof value.raw === "boolean",
    errors:
      value.raw === null || typeof value.raw === "boolean"
        ? []
        : [`Expected ${type} value to be a boolean or null.`]
  };
}

function validateDateValue(
  type: "date.date" | "date.datetime",
  value: NormalizedCellValue | null
): ValidationResult {
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

  if (value.raw === null) {
    return {
      valid: true,
      errors: []
    };
  }

  if (typeof value.raw !== "string") {
    return {
      valid: false,
      errors: [`Expected ${type} value to be an ISO string or null.`]
    };
  }

  if (type === "date.date") {
    const valid = isValidDateOnly(value.raw);
    return {
      valid,
      errors: valid ? [] : ["Expected date.date value to use YYYY-MM-DD format."]
    };
  }

  const valid =
    datetimePattern.test(value.raw) && !Number.isNaN(new Date(value.raw).getTime());
  return {
    valid,
    errors: valid
      ? []
      : ["Expected date.datetime value to use an ISO datetime with timezone."]
  };
}

function validatePrincipalConfig(config: unknown): ValidationResult {
  const { config: parsedConfig, errors } = validateObjectConfig(config, [
    "allowedRoleIds",
    "rowOwner",
    "workflowBindingAlias"
  ]);
  if (!parsedConfig) {
    return {
      valid: false,
      errors
    };
  }

  if (parsedConfig.allowedRoleIds !== undefined) {
    errors.push(...validateStringArray(parsedConfig.allowedRoleIds, "allowedRoleIds").errors);
  }
  if (parsedConfig.rowOwner !== undefined && typeof parsedConfig.rowOwner !== "boolean") {
    errors.push("rowOwner must be a boolean.");
  }
  if (parsedConfig.workflowBindingAlias !== undefined) {
    if (typeof parsedConfig.workflowBindingAlias !== "string") {
      errors.push("workflowBindingAlias must be a string.");
    } else {
      const alias = parsedConfig.workflowBindingAlias.trim();
      if (alias.length === 0) {
        errors.push("workflowBindingAlias must be a non-empty string.");
      } else if (!/^row\.[a-z][a-z0-9_]*$/.test(alias)) {
        errors.push("workflowBindingAlias must use the form row.<name>.");
      } else if (alias === "row.owner" && parsedConfig.rowOwner !== true) {
        errors.push("workflowBindingAlias row.owner requires rowOwner to be true.");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateReferenceValue(
  type: string,
  value: NormalizedCellValue | null,
  options: {
    allowMultiple: boolean;
    itemLabel: string;
  }
): ValidationResult {
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

  if (value.raw === null) {
    return {
      valid: true,
      errors: []
    };
  }

  if (!Array.isArray(value.raw)) {
    return {
      valid: false,
      errors: [`Expected ${type} value to be an array of ${options.itemLabel} ids.`]
    };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.raw.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(
        `Expected ${type} value entry ${index} to be a non-empty ${options.itemLabel} id.`
      );
      continue;
    }

    if (seen.has(entry)) {
      errors.push(`Expected ${type} value entries to be unique: ${entry}.`);
      continue;
    }

    seen.add(entry);
  }

  if (!options.allowMultiple && value.raw.length > 1) {
    errors.push(`Expected ${type} value to contain at most one ${options.itemLabel} id.`);
  }

  if (
    value.refs !== undefined &&
    JSON.stringify(value.refs) !== JSON.stringify(value.raw)
  ) {
    errors.push(`Expected ${type} refs metadata to match the canonical raw value.`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateRelationConfig(config: unknown): ValidationResult {
  const { config: parsedConfig, errors } = validateObjectConfig(config, [
    "allowMultiple",
    "reciprocalFieldId",
    "targetTableId"
  ]);
  if (!parsedConfig) {
    return {
      valid: false,
      errors
    };
  }

  if (
    typeof parsedConfig.targetTableId !== "string" ||
    parsedConfig.targetTableId.trim() === ""
  ) {
    errors.push("Field configuration targetTableId must be a non-empty string.");
  }

  if (
    parsedConfig.allowMultiple !== undefined &&
    typeof parsedConfig.allowMultiple !== "boolean"
  ) {
    errors.push("Field configuration allowMultiple must be a boolean.");
  }

  if (
    parsedConfig.reciprocalFieldId !== undefined &&
    (typeof parsedConfig.reciprocalFieldId !== "string" ||
      parsedConfig.reciprocalFieldId.trim() === "")
  ) {
    errors.push("Field configuration reciprocalFieldId must be a non-empty string.");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateComputedConfig(config: unknown): ValidationResult {
  const { config: parsedConfig, errors } = validateObjectConfig(config, [
    "dependsOnFieldIds",
    "expression",
    "lookupFieldId",
    "resultValueType"
  ]);
  if (!parsedConfig) {
    return {
      valid: false,
      errors
    };
  }

  if (
    typeof parsedConfig.expression !== "string" &&
    typeof parsedConfig.lookupFieldId !== "string"
  ) {
    errors.push(
      "Field configuration must include expression or lookupFieldId for computed.readonly."
    );
  }

  if (
    parsedConfig.expression !== undefined &&
    (typeof parsedConfig.expression !== "string" || parsedConfig.expression.trim() === "")
  ) {
    errors.push("Field configuration expression must be a non-empty string.");
  }

  if (
    parsedConfig.lookupFieldId !== undefined &&
    (typeof parsedConfig.lookupFieldId !== "string" ||
      parsedConfig.lookupFieldId.trim() === "")
  ) {
    errors.push("Field configuration lookupFieldId must be a non-empty string.");
  }

  if (parsedConfig.dependsOnFieldIds !== undefined) {
    errors.push(
      ...validateStringArray(parsedConfig.dependsOnFieldIds, "dependsOnFieldIds").errors
    );
  }

  if (
    parsedConfig.resultValueType !== undefined &&
    (typeof parsedConfig.resultValueType !== "string" ||
      parsedConfig.resultValueType.trim() === "")
  ) {
    errors.push("Field configuration resultValueType must be a non-empty string.");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateComputedValue(
  type: string,
  value: NormalizedCellValue | null
): ValidationResult {
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

  return {
    valid: isJsonValue(value.raw),
    errors: isJsonValue(value.raw)
      ? []
      : [`Expected ${type} value to contain a JSON-serializable payload.`]
  };
}

export const mvpFieldTypes: FieldTypeDefinition[] = [
  defineFieldType({
    type: "text.single_line",
    configSchema: {
      type: "object",
      description: "Single-line text fields do not define module-specific configuration.",
      additionalProperties: false,
      properties: {}
    },
    valueSchema: {
      type: "string",
      description: "Trimmed single-line text content, or null when empty."
    },
    sampleInput: "Alpha Bravo",
    validateConfig: (config) => validateTextConfig(config),
    validateValue: (value) => validateTextValue("text.single_line", value),
    normalizeSample: (input) => normalizeTextValue("text.single_line", input),
    invalidConfigFixtures: [
      {
        idSuffix: "unexpected_property",
        config: {
          maxLength: 120
        },
        expectedErrors: ["Field configuration contains unsupported property: maxLength."]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "non_string_raw",
        value: {
          valueType: "text.single_line",
          version: 1,
          raw: 42,
          isEmpty: false,
          tokens: ["42"]
        },
        expected: {
          errors: ["Expected text.single_line value to be a string or null."]
        }
      }
    ],
    indexSample: buildTextIndex
  }),
  defineFieldType({
    type: "text.long",
    configSchema: {
      type: "object",
      description: "Long-text fields do not define module-specific configuration in MVP.",
      additionalProperties: false,
      properties: {}
    },
    valueSchema: {
      type: "string",
      description: "Trimmed long-form text content, or null when empty."
    },
    sampleInput: "Alpha Bravo Charlie",
    validateConfig: (config) => validateTextConfig(config),
    validateValue: (value) => validateTextValue("text.long", value),
    normalizeSample: (input) => normalizeTextValue("text.long", input),
    invalidConfigFixtures: [
      {
        idSuffix: "unexpected_property",
        config: {
          richText: true
        },
        expectedErrors: ["Field configuration contains unsupported property: richText."]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "invalid_tokens",
        value: {
          valueType: "text.long",
          version: 1,
          raw: "Alpha Beta",
          isEmpty: false,
          tokens: ["alpha", ""]
        },
        expected: {
          errors: ["Expected text.long tokens to contain non-empty normalized strings."]
        }
      }
    ],
    indexSample: buildTextIndex
  }),
  defineFieldType({
    type: "number.decimal",
    configSchema: {
      type: "object",
      description: "Decimal number formatting and range constraints.",
      additionalProperties: false,
      properties: {
        display: {
          type: "string",
          description: "Display variant: plain, currency, or percent.",
          enum: ["plain", "currency", "percent"]
        },
        integerOnly: {
          type: "boolean",
          description: "Require values to be whole numbers."
        },
        max: {
          type: "number",
          description: "Inclusive maximum value."
        },
        min: {
          type: "number",
          description: "Inclusive minimum value."
        },
        precision: {
          type: "number",
          description: "Maximum decimal places allowed."
        }
      }
    },
    valueSchema: {
      type: "string",
      description: "Canonical decimal string, or null when empty."
    },
    supportedConditionOperators: ["equals", "not_equals", "number_compare"],
    sampleInput: "42.5",
    normalize: (input) => normalizeNumberValue("number.decimal", input),
    normalizeSample: (input) => normalizeNumberValue("number.decimal", input),
    validateConfig: (config) => validateNumberConfig(config),
    workflowProposalHints: ({ binding }) => [
      ...buildNumberComparisonWorkflowProposalHints(binding),
      ...defaultWorkflowProposalHints
    ],
    validateValue: (value, context) =>
      validateNumberValue("number.decimal", value, context.fieldConfig),
    invalidConfigFixtures: [
      {
        idSuffix: "precision_and_display",
        config: { precision: -1, display: "weird" },
        expectedErrors: [
          "Field configuration precision must be a non-negative integer.",
          "Field configuration display must be one of: plain, currency, percent."
        ]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "precision_exceeded",
        fieldConfig: { precision: 2 },
        input: "4.567",
        expected: {
          value: buildNormalizedValue("number.decimal", "4.567"),
          warnings: [],
          errors: ["Expected number.decimal value to use at most 2 decimal places."]
        }
      }
    ],
    indexSample: buildNumberIndex
  }),
  defineFieldType({
    type: "boolean.checkbox",
    configSchema: {
      type: "object",
      description: "Checkbox fields have no module-specific configuration.",
      additionalProperties: false,
      properties: {}
    },
    valueSchema: {
      type: "boolean",
      description: "Boolean checkbox state, or null when empty."
    },
    supportedSortModes: ["false_first", "true_first"],
    sampleInput: true,
    normalize: (input) => normalizeBooleanValue("boolean.checkbox", input),
    normalizeSample: (input) => normalizeBooleanValue("boolean.checkbox", input),
    workflowProposalHints: ({ binding }) => [
      ...buildBooleanEqualityWorkflowProposalHints(binding),
      ...defaultWorkflowProposalHints
    ],
    validateConfig: (config) => validateStrictObjectConfig(config, []),
    validateValue: (value) => validateBooleanValue("boolean.checkbox", value),
    invalidConfigFixtures: [
      {
        idSuffix: "unexpected_property",
        config: { unexpected: true },
        expectedErrors: ["Field configuration contains unsupported property: unexpected."]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "non_boolean_literal",
        input: "maybe",
        expected: {
          value: buildNormalizedValue("boolean.checkbox", "maybe"),
          warnings: [
            {
              code: "boolean.invalid",
              message: 'Could not normalize "maybe" as a boolean value.'
            }
          ],
          errors: ["Expected boolean.checkbox value to be a boolean or null."]
        }
      }
    ],
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
    configSchema: {
      type: "object",
      description: "Date-only fields have no module-specific configuration.",
      additionalProperties: false,
      properties: {}
    },
    valueSchema: {
      type: "string",
      description: "Canonical ISO date in YYYY-MM-DD format, or null when empty."
    },
    supportedConditionOperators: ["equals", "not_equals", "date_compare"],
    sampleInput: "2026-06-06",
    normalize: (input) => normalizeDateValue("date.date", input),
    normalizeSample: (input) => normalizeDateValue("date.date", input),
    validateConfig: (config) => validateStrictObjectConfig(config, []),
    workflowProposalHints: ({ binding }) => [
      ...buildDateComparisonWorkflowProposalHints(binding),
      ...defaultWorkflowProposalHints
    ],
    validateValue: (value) => validateDateValue("date.date", value),
    invalidConfigFixtures: [
      {
        idSuffix: "unexpected_property",
        config: { timezone: "UTC" },
        expectedErrors: ["Field configuration contains unsupported property: timezone."]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "calendar_overflow",
        input: "2026-02-30",
        expected: {
          value: buildNormalizedValue("date.date", "2026-02-30"),
          warnings: [
            {
              code: "date.invalid",
              message: 'Could not normalize "2026-02-30" as an ISO date.'
            }
          ],
          errors: ["Expected date.date value to use YYYY-MM-DD format."]
        }
      }
    ],
    indexSample: buildDateIndex
  }),
  defineFieldType({
    type: "date.datetime",
    configSchema: {
      type: "object",
      description: "Datetime fields have no module-specific configuration.",
      additionalProperties: false,
      properties: {}
    },
    valueSchema: {
      type: "string",
      description: "Canonical ISO datetime with timezone, or null when empty."
    },
    supportedConditionOperators: ["equals", "not_equals", "date_compare"],
    sampleInput: "2026-06-06T00:00:00.000Z",
    normalize: (input) => normalizeDateValue("date.datetime", input),
    normalizeSample: (input) => normalizeDateValue("date.datetime", input),
    validateConfig: (config) => validateStrictObjectConfig(config, []),
    workflowProposalHints: ({ binding }) => [
      ...buildDateComparisonWorkflowProposalHints(binding),
      ...defaultWorkflowProposalHints
    ],
    validateValue: (value) => validateDateValue("date.datetime", value),
    invalidConfigFixtures: [
      {
        idSuffix: "unexpected_property",
        config: { timezone: "UTC" },
        expectedErrors: ["Field configuration contains unsupported property: timezone."]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "missing_timezone",
        input: "2026-06-06T00:00:00",
        expected: {
          value: buildNormalizedValue("date.datetime", "2026-06-06T00:00:00"),
          warnings: [
            {
              code: "datetime.invalid",
              message: 'Could not normalize "2026-06-06T00:00:00" as an ISO datetime.'
            }
          ],
          errors: ["Expected date.datetime value to use an ISO datetime with timezone."]
        }
      }
    ],
    indexSample: buildDateIndex
  }),
  defineFieldType({
    type: "principal.user",
    capabilities: {
      reference: true
    },
    configSchema: {
      type: "object",
      description: "Workspace principal assignment constraints.",
      additionalProperties: false,
      properties: {
        allowedRoleIds: {
          type: "array",
          description: "Optional role ids allowed for assignment.",
          items: {
            type: "string",
            description: "Workspace role id."
          }
        },
        rowOwner: {
          type: "boolean",
          description: "Marks this principal field as the table's canonical row-owner binding."
        },
        workflowBindingAlias: {
          type: "string",
          description: "Optional canonical workflow binding alias exposed as row.<name>."
        }
      }
    },
    valueSchema: {
      type: "array",
      description: "Canonical workspace principal ids.",
      items: {
        type: "string",
        description: "Workspace principal id."
      }
    },
    sampleInput: ["user_002", "user_001"],
    normalize: (input) => normalizeReferenceValue("principal.user", input),
    normalizeSample: (input) => normalizeReferenceValue("principal.user", input),
    validateConfig: (config) => validatePrincipalConfig(config),
    workflowBindingAliases: ({ fieldConfig }) => listPrincipalUserCanonicalBindings(fieldConfig ?? null),
    workflowProposalHints: ({ binding, bindingKind, isCanonical }) =>
      bindingKind === "alias" && isCanonical === true
        ? [
            {
              operatorId: "not_equals",
              matchPhrases: ["does not equal", "not equals", "not assigned to"],
              matchFieldPhrases: [
                "{field} does not equal",
                "{field} not equals",
                "{field} is not",
                "{field} is not assigned to",
                "{field} not assigned to"
              ],
              draftInput: {
                left: {
                  path: `${binding}.value`
                },
                right: null
              }
            },
            {
              operatorId: "equals",
              matchPhrases: ["equals", "assigned to"],
              matchFieldPhrases: [
                "{field} equals",
                "{field} is assigned to",
                "{field} assigned to"
              ],
              draftInput: {
                left: {
                  path: `${binding}.value`
                },
                right: null
              }
            },
            {
              operatorId: "is_empty",
              matchPhrases: ["unassigned"],
              matchFieldPhrases: ["without {field}", "{field} missing"]
            },
            {
              operatorId: "is_not_empty",
              matchPhrases: ["assigned"]
            }
          ]
        : [
            {
              operatorId: "is_empty",
              matchPhrases: ["missing", "empty", "blank", "not set", "unset"],
              matchFieldPhrases: ["without {field}", "{field} missing"]
            },
            {
              operatorId: "is_not_empty",
              matchPhrases: ["present", "populated", "filled", "has value", "is set", "set"]
            }
          ],
    validateValue: (value) =>
      validateReferenceValue("principal.user", value, {
        allowMultiple: true,
        itemLabel: "principal"
      }),
    invalidConfigFixtures: [
      {
        idSuffix: "duplicate_role_ids",
        config: { allowedRoleIds: ["admin", "admin", ""] },
        expectedErrors: [
          "allowedRoleIds entries must be unique: admin.",
          "allowedRoleIds entry 2 must be a non-empty string."
        ]
      },
      {
        idSuffix: "row_owner_non_boolean",
        config: { rowOwner: "yes" },
        expectedErrors: ["rowOwner must be a boolean."]
      },
      {
        idSuffix: "workflow_binding_alias_non_string",
        config: { workflowBindingAlias: true },
        expectedErrors: ["workflowBindingAlias must be a string."]
      },
      {
        idSuffix: "workflow_binding_alias_invalid_shape",
        config: { workflowBindingAlias: "fields.owner" },
        expectedErrors: ["workflowBindingAlias must use the form row.<name>."]
      },
      {
        idSuffix: "workflow_binding_alias_row_owner_requires_row_owner",
        config: { workflowBindingAlias: "row.owner" },
        expectedErrors: ["workflowBindingAlias row.owner requires rowOwner to be true."]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "duplicate_principal_refs",
        value: {
          isEmpty: false,
          raw: ["user_1", "user_1"],
          refs: ["user_1", "user_1"],
          valueType: "principal.user",
          version: 1
        },
        expected: {
          errors: ["Expected principal.user value entries to be unique: user_1."]
        }
      }
    ],
    indexSample: buildReferenceIndex
  }),
  defineFieldType({
    type: "relation.record",
    capabilities: {
      scalar: false,
      multiValue: true,
      reference: true
    },
    configSchema: {
      type: "object",
      description: "Linked-record relation targets and cardinality.",
      additionalProperties: false,
      required: ["targetTableId"],
      properties: {
        allowMultiple: {
          type: "boolean",
          description: "Allow more than one related record."
        },
        reciprocalFieldId: {
          type: "string",
          description: "Optional reciprocal relation field id."
        },
        targetTableId: {
          type: "string",
          description: "Target table id for linked records."
        }
      }
    },
    valueSchema: {
      type: "array",
      description: "Canonical related record ids.",
      items: {
        type: "string",
        description: "Related record id."
      }
    },
    defaultConfig: {
      allowMultiple: true,
      targetTableId: "tbl_related"
    },
    supportedConditionOperators: ["relation_contains_record", "is_empty", "is_not_empty"],
    sampleInput: ["rec_002", "rec_001"],
    normalize: (input) => normalizeReferenceValue("relation.record", input),
    normalizeSample: (input) => normalizeReferenceValue("relation.record", input),
    validateConfig: (config) => validateRelationConfig(config),
    validateValue: (value, context) =>
      validateReferenceValue("relation.record", value, {
        allowMultiple:
          !isRecord(context.fieldConfig) || context.fieldConfig.allowMultiple !== false,
        itemLabel: "record"
      }),
    invalidConfigFixtures: [
      {
        idSuffix: "missing_target_and_bad_cardinality",
        config: { allowMultiple: "yes" },
        expectedErrors: [
          "Field configuration targetTableId must be a non-empty string.",
          "Field configuration allowMultiple must be a boolean."
        ]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "single_relation_overflow",
        fieldConfig: { allowMultiple: false, targetTableId: "tbl_related" },
        value: {
          isEmpty: false,
          raw: ["rec_1", "rec_2"],
          refs: ["rec_1", "rec_2"],
          valueType: "relation.record",
          version: 1
        },
        expected: {
          errors: ["Expected relation.record value to contain at most one record id."]
        }
      }
    ],
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
    configSchema: {
      type: "object",
      description: "Derived field expression or lookup contract.",
      additionalProperties: false,
      properties: {
        dependsOnFieldIds: {
          type: "array",
          description: "Upstream field ids used by the computed value.",
          items: {
            type: "string",
            description: "Source field id."
          }
        },
        expression: {
          type: "string",
          description: "Deterministic computed expression identifier."
        },
        lookupFieldId: {
          type: "string",
          description: "Optional lookup field id."
        },
        resultValueType: {
          type: "string",
          description: "Optional downstream logical result type."
        }
      }
    },
    valueSchema: {
      type: "json",
      description: "JSON-serializable computed payload."
    },
    defaultConfig: {
      dependsOnFieldIds: ["fld_source"],
      expression: "source.value"
    },
    sampleInput: "derived-value",
    normalize: (input) => normalizeOpaqueValue("computed.readonly", input),
    normalizeSample: (input) => normalizeOpaqueValue("computed.readonly", input),
    validateConfig: (config) => validateComputedConfig(config),
    validateValue: (value) => validateComputedValue("computed.readonly", value),
    invalidConfigFixtures: [
      {
        idSuffix: "empty_expression_and_duplicate_dependencies",
        config: { expression: "", dependsOnFieldIds: ["fld_1", "fld_1"] },
        expectedErrors: [
          "Field configuration expression must be a non-empty string.",
          "dependsOnFieldIds entries must be unique: fld_1."
        ]
      }
    ],
    invalidValueFixtures: [
      {
        idSuffix: "non_json_payload",
        value: {
          isEmpty: false,
          raw: Symbol("bad-payload") as never,
          valueType: "computed.readonly",
          version: 1
        },
        expected: {
          errors: ["Expected computed.readonly value to contain a JSON-serializable payload."]
        }
      }
    ],
    indexSample: buildOpaqueIndex
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
