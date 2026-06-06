# CloudTable Field Type Registry Contract

## 1. Purpose

CloudTable must support many field types without spreading field-specific branching through command handlers, view queries, workflow conditions, permissions, and agent tools.

The platform should treat field types as registered capabilities. Core runtime code knows how to call a field type definition; it does not know the internals of text, number, relation, attachment, rich text, geolocation, rollup, or future field types.

The implementation-ready Phase 1 scaffold plan for this contract lives in `cloudtable-field-type-registry-phase1-design.md`.

## 2. Design Rule

Adding a field type must require adding a field type module and tests, not editing the command engine, permission engine, workflow engine, or view planner except where a genuinely new storage/index primitive is required.

Field types are code-level plugins for MVP. They are not user-installed runtime plugins. This keeps replay deterministic and makes migrations auditable.

## 3. Registry Shape

Each field type registers a stable definition:

```ts
export type FieldTypeDefinition = {
  type: string;
  version: number;
  capabilities: FieldTypeCapabilities;
  configSchema: JsonSchema;
  valueSchema: JsonSchema;
  defaultConfig: unknown;

  normalize(input: unknown, context: NormalizeContext): NormalizedCellValue;
  validateConfig(config: unknown, context: FieldSchemaContext): ValidationResult;
  validateValue(value: NormalizedCellValue, context: CellValidationContext): ValidationResult;

  applyDefault(context: DefaultValueContext): NormalizedCellValue | null;
  toDisplay(value: NormalizedCellValue, context: DisplayContext): string;
  toIndex(value: NormalizedCellValue, context: IndexContext): FieldIndexValue;
  toSearchText(value: NormalizedCellValue, context: SearchContext): string;

  getSupportedConditionOperators(context: OperatorContext): string[];
  getSupportedSortModes(context: SortContext): string[];
  getPermissionBehavior(context: PermissionContext): FieldPermissionBehavior;

  migrateConfig?(fromVersion: number, config: unknown): unknown;
  migrateValue?(fromVersion: number, value: unknown): NormalizedCellValue;
  fixtures: FieldTypeFixture[];
};
```

## 4. Normalized Cell Value

Every field type writes through the same canonical cell storage:

- `value_type`: stable field type id or normalized primitive class.
- `value_json`: complete canonical value.
- `text_value`, `number_value`, `bool_value`, `datetime_value`, `reference_value`: optional helper columns for common filters/sorts.
- `display_value`: deterministic display string.
- `value_hash`: canonical hash for idempotency, conflict checks, and replay comparison.

`value_json` remains the recoverable source for the cell value. Helper columns are derived projections and must be rebuildable from `value_json` plus field config.

## 5. Field Type Capabilities

The registry should declare capabilities instead of relying on hardcoded type checks:

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

Examples:

- Text supports filtering, sorting, grouping, search, defaults, and agent mutation.
- Relation supports references, filtering, workflow triggers, and picker-style mutation, but needs reference validation.
- Computed supports filtering and display, but not direct user or agent mutation.
- Attachment can support display and workflow triggers while deferring binary storage to R2.

## 6. Operators

Condition operators bind to field-type capabilities and field-type adapters:

- `equals`
- `not_equals`
- `is_empty`
- `is_not_empty`
- `text_contains`
- `text_starts_with`
- `number_compare`
- `date_compare`
- `select_has_option`
- `relation_contains_record`

The workflow engine should ask the field type registry whether an operator is valid for a field. The engine should not contain branches like `if field.type === "number"`.

## 7. Permissions

Field-level permission enforcement happens before and after field-type normalization:

1. Check whether the actor can read or mutate the field.
2. Check whether the field type allows the requested operation.
3. Normalize and validate input.
4. Re-check contextual constraints that depend on normalized values, such as relation target visibility.
5. Emit an auditable command result and event.

Redaction is a field-type-aware operation. A relation field may redact the linked record label differently from a text field, but the permission engine should call `getPermissionBehavior` rather than embedding type-specific logic.

## 8. Schema Evolution

Field schema changes are workspace-scoped schema mutations and must be serialized through the coordinator.

Changing a field type is not a generic edit. It is a migration operation with an explicit conversion plan:

- source field type and version
- target field type and version
- value conversion function
- invalid value handling
- projection/index rebuild requirement
- rollback behavior when possible

The MVP should allow safe config changes inside the same field type first, such as number precision, select options, required/default settings, display labels, and relation cardinality rules.

## 9. Deterministic Fixtures

Every field type must ship fixtures covering:

- valid config
- invalid config
- valid values
- invalid values
- null/empty behavior
- normalization stability
- display value stability
- index value stability
- permission redaction
- workflow condition compatibility
- replay across field type version migration

These fixtures are part of the SQLite-like testing goal. A new field type is not accepted without replayable fixtures.

## 10. MVP Field Type Modules

Phase 1 should implement the registry plus these first modules:

- `text.single_line`
- `text.long`
- `number.decimal`
- `boolean.checkbox`
- `select.single`
- `select.multi`
- `date.date`
- `date.datetime`
- `principal.user`
- `relation.record`
- `computed.readonly`
- `status.semantic`

Deferred modules such as attachments, rich text, geolocation, JSON/object, rollups, and formulas must use the same registry contract.

## 11. Acceptance Criteria

- The command engine validates and normalizes cells by calling the registry.
- The view planner obtains filter/sort/search support from the registry.
- The workflow condition registry can ask field types which operators are valid.
- The permission engine obtains redaction/mutation behavior from the registry.
- Each MVP field type has deterministic fixtures.
- Adding a new simple field type requires no edits to command, workflow, permission, or view engine core.
