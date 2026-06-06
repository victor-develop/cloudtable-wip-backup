# CloudTable Field Type Registry Phase 1 Design

## 1. Purpose

This document turns `cloudtable-field-type-registry-contract.md` into an implementation-ready Phase 1 scaffold plan.

The goal is to let the first CloudTable runtime components depend on a single field type registry contract instead of embedding type-specific branching in command handling, validation, indexing, views, workflows, permissions, or agent tools.

## 2. Deliverable Shape

Phase 1 should ship three layers:

1. A stable TypeScript contract package for field type definitions, normalized values, fixtures, and registry lookups.
2. A registry runtime that loads built-in field type modules and exposes deterministic lookup helpers.
3. An initial built-in field type catalog with replayable fixtures for MVP field families.

This phase does not need a full application implementation. It does need enough type and module structure that later command, view, workflow, permission, and agent-tool work can integrate without revisiting the foundation.

## 3. Proposed Module Boundaries

The implementation should separate contract types from runtime registration:

```text
cloudtable/
  field-types/
    contract/
      field-type-definition.ts
      field-type-capabilities.ts
      normalized-cell-value.ts
      field-index-value.ts
      field-type-fixture.ts
      operators.ts
      contexts.ts
      errors.ts
    registry/
      field-type-registry.ts
      builtin-field-types.ts
      assert-field-type.ts
    modules/
      text-single-line.ts
      text-long.ts
      number-decimal.ts
      boolean-checkbox.ts
      select-single.ts
      select-multi.ts
      date-date.ts
      date-datetime.ts
      principal-user.ts
      relation-record.ts
      computed-readonly.ts
      status-semantic.ts
    fixtures/
      text-single-line.fixture.ts
      ...
```

Design rule:

- `contract/` contains stable engine-facing types only.
- `registry/` contains registration, lookup, duplicate detection, and deterministic iteration order.
- `modules/` contains built-in field type implementations.
- Fixtures live adjacent to modules or in a dedicated `fixtures/` directory, but they must remain importable without runtime discovery heuristics.

## 4. Finalized TypeScript Contract

The runtime should converge on a slightly more explicit interface than the current contract sketch:

```ts
export type FieldTypeId =
  | "text.single_line"
  | "text.long"
  | "number.decimal"
  | "boolean.checkbox"
  | "select.single"
  | "select.multi"
  | "date.date"
  | "date.datetime"
  | "principal.user"
  | "relation.record"
  | "computed.readonly"
  | "status.semantic";

export type FieldTypeDefinition<
  TConfig = unknown,
  TValue = unknown,
  TNormalized extends NormalizedCellValue = NormalizedCellValue,
> = {
  type: FieldTypeId | string;
  version: number;
  family: FieldFamily;
  capabilities: FieldTypeCapabilities;

  configSchema: JsonSchema;
  valueSchema: JsonSchema;
  defaultConfig: TConfig;

  normalize(input: TValue, context: NormalizeContext<TConfig>): NormalizeResult<TNormalized>;
  validateConfig(config: unknown, context: FieldSchemaContext): ValidationResult;
  validateValue(value: TNormalized, context: CellValidationContext<TConfig>): ValidationResult;

  applyDefault(context: DefaultValueContext<TConfig>): TNormalized | null;
  toDisplay(value: TNormalized, context: DisplayContext<TConfig>): string;
  toIndex(value: TNormalized, context: IndexContext<TConfig>): FieldIndexValue;
  toSearchText(value: TNormalized, context: SearchContext<TConfig>): string;
  toHash(value: TNormalized, context: HashContext<TConfig>): string;

  getSupportedConditionOperators(context: OperatorContext<TConfig>): ConditionOperator[];
  getSupportedSortModes(context: SortContext<TConfig>): SortMode[];
  getPermissionBehavior(context: PermissionContext<TConfig>): FieldPermissionBehavior;

  migrateConfig?(fromVersion: number, config: unknown): TConfig;
  migrateValue?(fromVersion: number, value: unknown): TNormalized;

  fixtures: FieldTypeFixture<TConfig, TValue, TNormalized>[];
};
```

Phase 1 additions versus the earlier contract:

- `family` groups related types such as `text`, `number`, `date`, `select`, and `relation` for reporting and diagnostics, not behavioral branching.
- `normalize` returns a `NormalizeResult` so warnings and derived metadata can be carried without side channels.
- `toHash` is explicit rather than being implied through canonical JSON serialization.
- Operator and sort methods return stable enum values instead of free-form strings.
- Generic config/value typing lets each module keep internal type safety while the registry still stores `FieldTypeDefinition<unknown, unknown>`.

## 5. Registry Runtime Contract

The registry should expose a very small API surface:

```ts
export interface FieldTypeRegistry {
  list(): readonly FieldTypeDefinition[];
  get(type: string): FieldTypeDefinition;
  has(type: string): boolean;
  require(type: string): FieldTypeDefinition;
}

export type CreateFieldTypeRegistryInput = {
  fieldTypes: readonly FieldTypeDefinition[];
};

export function createFieldTypeRegistry(
  input: CreateFieldTypeRegistryInput,
): FieldTypeRegistry;
```

Registry invariants:

- registration order is deterministic
- duplicate `type` registrations fail at startup
- duplicate fixture ids inside one field type fail at startup
- lookup is pure and side-effect-free
- registry contents are static for a process lifetime in MVP

Core engines should only depend on `FieldTypeRegistry`, never on individual module imports.

## 6. Normalized Cell Value Shape

Each field type should normalize user input into a canonical value with enough structure for replay, hashing, and projection:

```ts
export type NormalizedCellValue = {
  valueType: string;
  version: number;
  raw: JsonValue | null;
  isEmpty: boolean;
  tokens?: readonly string[];
  refs?: readonly string[];
  meta?: Record<string, JsonValue>;
};

export type NormalizeResult<TNormalized extends NormalizedCellValue> = {
  value: TNormalized | null;
  warnings: readonly NormalizeWarning[];
};
```

Semantics:

- `valueType` is the stable field type id.
- `version` is the field type version used to normalize the value.
- `raw` is the canonical JSON payload that gets persisted as `value_json`.
- `isEmpty` makes empty semantics explicit instead of re-deriving emptiness from type-specific rules.
- `tokens` is optional pre-tokenized search text for modules that need deterministic token boundaries.
- `refs` is optional extracted reference ids for relation/user-like modules.
- `meta` is reserved for deterministic, rebuildable derived facts such as normalized timezone mode or option ids.

The persistence model derived from a normalized value should be:

```ts
export type CellStorageProjection = {
  value_type: string;
  value_version: number;
  value_json: JsonValue | null;
  text_value: string | null;
  number_value: string | null;
  bool_value: boolean | null;
  datetime_value: string | null;
  reference_value: string | null;
  display_value: string;
  search_text: string;
  value_hash: string;
};
```

Notes:

- `number_value` should be stored in a deterministic decimal-safe format owned by the number/currency/percent family.
- `datetime_value` should be an RFC 3339 UTC string for deterministic comparisons.
- `reference_value` is a primary helper column, not the full list of references. Multi-reference types still persist full refs in `value_json`.
- `search_text` must be deterministic and safe to regenerate from normalized value plus config.

## 7. Helper Column and Index Rules

Each field type owns the mapping from normalized value to helper columns through `toIndex`.

`toIndex` should return:

```ts
export type FieldIndexValue = {
  textValue?: string | null;
  numberValue?: string | null;
  boolValue?: boolean | null;
  datetimeValue?: string | null;
  referenceValue?: string | null;
  searchText: string;
};
```

Rules:

- Helper columns are optional projections, not alternate sources of truth.
- Empty values must clear all helper columns consistently.
- If a field type cannot support a helper column deterministically, it must leave that column null.
- Search text must be normalized for stable comparisons and fixtures.
- Hash input must be derived from canonical normalized JSON, not raw user input.

## 8. Capability Flags and Engine Consumption

The capability object in the contract is the only engine-facing behavioral summary:

```ts
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
```

Consumption rules:

- Command engine checks `userEditable`, `computed`, `supportsDefaultValue`, and `supportsUniqueConstraint` before invoking type-specific logic.
- View planner checks `supportsFiltering`, `supportsSorting`, `supportsGrouping`, and `supportsSearch` before asking for operators or sort modes.
- Workflow engine checks `supportsWorkflowTrigger` and `getSupportedConditionOperators`.
- Permission engine checks `userEditable`, `supportsAgentMutation`, and `getPermissionBehavior`.
- Agent tools check `supportsAgentMutation` to shape tool affordances and reject unsafe mutation attempts early.

Capability flags are coarse routing hints. They do not replace module-level validation.

## 9. Permission Behavior Contract

The permission layer needs a normalized return shape rather than ad hoc booleans:

```ts
export type FieldPermissionBehavior = {
  redactMode: "plain" | "mask" | "reference_label_only" | "hidden";
  allowsHumanWrite: boolean;
  allowsAgentWrite: boolean;
  requiresReferenceVisibilityCheck: boolean;
};
```

This keeps type-specific redaction behavior in modules while the permission engine keeps control of actor- and policy-specific authorization.

## 10. Operator and Sort Enumerations

Condition and sort modes should be typed centrally:

```ts
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "is_empty"
  | "is_not_empty"
  | "text_contains"
  | "text_starts_with"
  | "number_compare"
  | "date_compare"
  | "select_has_option"
  | "relation_contains_record";

export type SortMode =
  | "alphanumeric"
  | "numeric"
  | "datetime"
  | "option_order"
  | "reference_label";
```

Adding an operator still requires registry-level typing, but adding a new simple field type must not require core-engine branching.

## 11. MVP Module Expectations

Each built-in module should own:

- typed config shape
- config validation
- value normalization
- display formatting
- helper-column projection
- search text derivation
- value hashing input
- supported operators and sort modes
- permission behavior
- deterministic fixtures

Recommended Phase 1 module matrix:

- `text.single_line`: scalar text, regex and length constraints, alphanumeric sorting, text search.
- `text.long`: scalar text, larger payload allowance, search enabled, grouping optional off by default.
- `number.decimal`: scalar numeric canonicalization, integer/precision/min/max config, numeric sort.
- `boolean.checkbox`: scalar boolean normalization, equality and empty operators only.
- `select.single`: single option id canonicalization, option-order sorting, search by label.
- `select.multi`: ordered option id set canonicalization, multi-value filtering, grouping disabled in MVP.
- `date.date`: date-only canonical form, date compare, display via workspace locale rules.
- `date.datetime`: UTC timestamp canonical form, date compare, timezone-aware display.
- `principal.user`: workspace principal reference id, reference visibility checks, search via resolved label.
- `relation.record`: target table id plus record id list, relation operators, reference visibility checks.
- `computed.readonly`: normalized derived payload contract, never writable, deterministic display/index from upstream computed output.
- `status.semantic`: single-select-derived module with semantic config like `todo`, `in_progress`, `done`, blocked-style states, and workflow-trigger emphasis.

## 12. Deterministic Fixture Format

Every field type should ship table-driven fixtures instead of free-form tests:

```ts
export type FieldTypeFixture<TConfig, TValue, TNormalized> = {
  id: string;
  description: string;
  config: TConfig;
  input: TValue;
  expected: {
    normalized: TNormalized | null;
    display: string;
    index: FieldIndexValue;
    hash: string;
    searchText: string;
    supportedOperators?: readonly ConditionOperator[];
    permissionBehavior?: FieldPermissionBehavior;
    validationErrors?: readonly string[];
    warnings?: readonly string[];
  };
};
```

Fixture rules:

- ids must be stable and human-readable
- order must be deterministic
- fixtures must not depend on wall-clock time, locale drift, random ids, or network state
- hashes must be pinned in fixtures so canonicalization regressions are caught immediately
- display and search output must be pinned for replay
- migration fixtures must include source version, source value, and expected migrated value

Recommended fixture buckets per module:

- config acceptance
- config rejection
- empty value normalization
- valid value normalization
- invalid value rejection
- display formatting
- helper projection
- search text projection
- permission behavior
- supported operator coverage
- migration replay

## 13. Phase 1 Scaffold Sequence

The implementation sequence should be:

1. Create contract types for definitions, capabilities, contexts, operators, sort modes, normalized values, index values, permission behavior, and fixtures.
2. Build `createFieldTypeRegistry` with duplicate detection and deterministic `list/get/require`.
3. Implement one thin vertical slice module first: `text.single_line`.
4. Add a fixture runner that executes module fixtures against normalize, display, index, hash, and operator methods.
5. Add the remaining scalar modules: long text, number, boolean, select, date.
6. Add reference-aware modules: user and relation.
7. Add computed and status modules after the scalar/select primitives exist.
8. Expose one engine-facing integration sample for command validation and one for workflow/operator lookup to prove the contract is sufficient.

This sequence is intentionally biased toward validating the extension point before implementing the harder reference and computed cases.

## 14. Acceptance Criteria For Phase 1

Phase 1 is complete when all of the following are true:

- A registry package exists with stable TypeScript types and deterministic lookup behavior.
- Built-in MVP field types register through the same runtime path.
- Every built-in field type ships deterministic fixtures covering normalization, display, indexing, hash, and operator behavior.
- Command-validation scaffolding can normalize a cell using only `registry.require(field.type)`.
- View/workflow scaffolding can derive supported filter and sort behavior using only capabilities and module methods.
- Permission scaffolding can obtain field-specific redaction and mutation behavior using only registry methods.
- A future simple scalar field type can be added by creating one module and fixtures, then registering it in the built-in catalog, without editing command, workflow, permission, or view engine core.

## 15. Non-Goals

Phase 1 should not include:

- user-installed runtime plugins
- production storage adapter implementation
- full workflow engine implementation
- formula language design
- attachment binary pipeline design
- cross-table rollup execution

Those systems should depend on this contract later rather than expanding this phase into full application work.
