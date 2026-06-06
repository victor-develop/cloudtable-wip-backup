# CloudTable Product Semantics and UX Contract

## 1. Product Positioning

CloudTable is a multi-tenant, Cloudflare-native smart-table platform for teams that want Airtable-like data modeling with stricter permissions, event-backed workflows, and safe agent assistance.

The product contract for MVP is:

- Builders create apps composed of tables, views, workflows, and scoped automations.
- End users work primarily through views, not raw tables.
- Every user-visible mutation maps to a validated command and auditable event.
- Agent assistance is allowed only through constrained tools that respect the same permission model as human users.

## 2. Primary Personas

- `Workspace Admin`: creates workspace structure, manages billing and global permissions.
- `App Builder`: defines apps, tables, fields, views, workflows, and role policies.
- `Operator`: updates records through task-oriented views and runs manual workflows.
- `Approver`: reviews grouped queues, changes record status, and inspects workflow history.
- `Agent Operator`: uses AI assistance to draft schema, generate views, explain permissions, or perform scoped bulk updates.

## 3. MVP User Journeys

### 3.1 Create a workspace and first app

1. User creates a workspace.
2. User creates an app with a name, icon, and short purpose statement.
3. Product offers one of three starts:
   - blank app
   - import structured CSV
   - guided starter from a common pattern such as CRM, approvals, or content pipeline
4. User lands in a first-table setup flow instead of an empty dashboard.

### 3.2 Create a table and define schema

1. Builder names the table and picks a primary field.
2. Builder adds fields from a typed catalog.
3. Each field setup form shows:
   - label
   - type
   - required or optional
   - default behavior
   - validation rules
   - permission overrides
4. Product creates a default grid view automatically.
5. Product prompts for one of:
   - add sample records
   - import CSV
   - create another table

### 3.3 Build a workflow-backed operational app

1. Builder creates base tables.
2. Builder creates focused views for each operational role.
3. Builder adds a workflow from a view or field context, not from an abstract automation screen first.
4. Workflow authoring starts with a business sentence:
   - "When status changes to Approved, create a follow-up task and notify Ops."
5. Product converts that into trigger, conditions, and actions that remain editable in structured form.

### 3.4 Operate through views

1. Operator opens a role-specific view.
2. Operator sees only allowed fields and rows.
3. Inline edits are allowed only for writable fields.
4. Bulk actions are limited to fields and records the operator can mutate.
5. Grouped views act as work queues, not just visual summaries.

### 3.5 Use agent assistance safely

1. Builder invokes an agent task from an app, table, view, or workflow context.
2. Product shows the exact scope the agent can access.
3. Agent proposes changes in draft form.
4. User reviews a command preview before execution when the action is mutating or bulk.
5. Completed agent actions write audit-linked events and surface in activity history.

## 4. App and Navigation Contract

### Workspace level

- Workspace is the tenant and top-level permission boundary.
- Workspace home shows apps, recent activity, and admin controls.
- Cross-app querying is not part of MVP.

### App level

- App is the main product container users recognize.
- App navigation contains:
  - tables
  - views
  - workflows
  - activity
  - settings
- Tables and views are app-scoped.
- Workflows are authored within an app and can reference app tables only in MVP.

### Table level

- Table owns schema, records, and default views.
- Table detail includes:
  - schema
  - default grid
  - saved views
  - recent activity

## 5. Field Type Catalog and User-Facing Semantics

### Core field types for MVP

- `Single line text`
  - short labels, names, IDs, codes
  - optional regex validation
- `Long text`
  - notes and descriptions
  - plain text only in MVP
- `Number`
  - integer or decimal
  - optional precision and min/max validation
  - display variants may include plain number, currency formatting, or percent formatting without becoming separate field-type modules
- `Boolean`
  - true/false checkbox semantics
- `Single select`
  - exactly one option from a builder-managed list
- `Multi select`
  - zero or more options from a builder-managed list
- `Date`
  - date without time
- `Date time`
  - timestamp with timezone-aware display
- `User`
  - references a workspace principal
  - optionally limited to assignable roles
- `Relation`
  - links one record to records in another table
  - supports one-to-one or one-to-many cardinality at the UX layer
- `Computed`
  - derived, read-only field from a constrained expression or lookup
  - not a full spreadsheet formula language
- `Status`
  - specialized single select with semantic color and workflow-friendly meaning

The frozen MVP catalog maps to these registry modules:

- `Single line text` -> `text.single_line`
- `Long text` -> `text.long`
- `Number` -> `number.decimal`
- `Boolean` -> `boolean.checkbox`
- `Single select` -> `select.single`
- `Multi select` -> `select.multi`
- `Date` -> `date.date`
- `Date time` -> `date.datetime`
- `User` -> `principal.user`
- `Relation` -> `relation.record`
- `Computed` -> `computed.readonly`
- `Status` -> `status.semantic`

### Deferred field types

- attachments
- rich text
- geolocation
- JSON/object blobs
- rollups with advanced aggregations
- arbitrary formulas and cross-table expression chains

### Field semantics rules

- Every table must have one primary field used as the default record label.
- Computed fields are never directly editable.
- Relation fields must expose the referenced table and display field.
- Status is treated as a first-class workflow trigger candidate in the UI.
- Single select and status options are schema, not data. Editing options is a schema mutation.
- Required field validation evaluates after defaults and builder-configured derived values are applied, but before workflow side effects commit.
- Empty semantics are type-aware and must come from the field registry rather than ad hoc UI logic.
- Display formatting cannot widen access. Currency-style and percent-style number rendering are presentation settings on readable numeric values only.
- Field types are backed by a shared registry contract so future types can define config schema, value schema, validation, display, indexing, supported workflow operators, permission behavior, and deterministic fixtures without changing the core engines.

## 6. Record UX Contract

### Record creation

- Users can create records from table or view context.
- Default values apply before workflow execution.
- Hidden-but-required fields must be satisfiable by defaults, workflow actions, or builder-only forms; operators cannot be blocked by inaccessible required inputs.

### Record editing

- Inline edit is the default for writable scalar fields.
- Complex types such as relation or user fields open a picker.
- If a field is visible but read-only, it must show a lock state with a reason on hover or tap.

### Bulk updates

- Bulk update is limited to fields the acting principal can write for all selected records.
- If the selection contains mixed permission outcomes, the UI must narrow the action or explain the partial restriction before submission.

### Record detail

- Record detail presents all readable fields, activity, and workflow history.
- Related records appear as linked references, not embedded spreadsheet joins.

## 7. View Contract

### View types in MVP

- `Grid`
- `Filtered grid`
- `Grouped grid`

### Shared behavior

- A view is a saved projection over one base table.
- A view stores visible fields, field order, filters, sorts, grouping, and permission narrowing.
- A view never expands access beyond table and field permissions.
- A view can hide fields or narrow rows further than the base table.
- View configuration is schema metadata, while each viewer still receives a permission-filtered result at read time.
- If view settings and policy disagree, the more restrictive outcome wins per row, field, and action.

### Grid behavior

- Default editing surface for most work.
- Supports inline editing, field resize, sort, and filter.
- New records appear according to active sort rules; when placement would be ambiguous, product uses a stable created-at fallback.

### Filtered grid behavior

- Filters are authored in human-readable rule form.
- Rows failing filters disappear from the view but remain in the base table.
- Users cannot infer hidden field values from filter descriptions when they lack read permission on the referenced field.
- If a filter uses a field the current user cannot read, the UI shows the filter as policy-protected and only exposes the existence of the filter, not the value.
- Unreadable filter fields may still constrain row membership when the builder has configured them, but they must not leak the protected comparison operand through chips, counts, previews, or empty-state copy.

### Grouped grid behavior

- Grouping is allowed on readable discrete fields such as status, single select, user, or date buckets.
- Group headers show group label and count based only on visible rows.
- Dragging a record between groups is treated as an edit to the grouping field and requires write permission on that field.
- Empty groups may appear only when the builder enables "show empty groups."
- If the grouping field is unreadable to a principal, the grouped view is not available as a grouped interaction surface for that principal.

### Field hiding and ordering

- Hiding a field in a view is a presentation choice, not a permission grant or revoke.
- Field order is view-specific unless edited in the base table schema layout.

### Editing through a view

- Allowed only when the user can mutate the target record and each touched field.
- If a grouped move or inline edit would violate permissions, the view blocks the interaction with an explicit reason.

### View permission overlays

- Table and field policy define the maximum visible surface.
- View access can further narrow which users can open the view.
- View-level hidden fields are cosmetic only for principals who could otherwise read those fields elsewhere.
- View-level row narrowing applies after base permission evaluation, never before.
- Exports, prints, and shared representations of a view use the same permission-redacted output as the interactive surface.

## 8. Permission UX Contract

### Permission model surfaced to builders

Builders configure permissions with role-based presets plus optional field overrides. The product should avoid presenting raw ACL complexity first.

### Permission scopes exposed in MVP

- workspace role
- app role
- table access
- field visibility and write rules
- view access
- workflow publish and execute rights
- agent tool access

### Field-level settings

For each field, builders can configure:

- `Visible to`
- `Writable by`
- `Redact in views and exports`
- `Available to workflows`
- `Available to agents`

### UX principles

- Visibility and editability are configured separately.
- Redaction means a caller may know the field exists but not its value.
- Workflow-visible and agent-visible are explicit toggles because workflow and AI access must not be implied by human view access.
- The settings UI must explain inheritance from workspace, app, and table scopes before showing overrides.

### Recommended builder flow

1. Choose app or table role preset.
2. Review generated defaults.
3. Apply field exceptions only where needed.
4. Preview effective access as a selected persona.

### Persona preview

- Builders can inspect "what does Support Agent see in this view?"
- Preview must show:
  - hidden fields
  - read-only fields
  - redacted values
  - blocked actions

## 9. Workflow Authoring UX Contract

### Workflow builder structure

- Trigger
- Conditions
- Actions
- Execution settings
- Test and history

### Workflow authoring states

- `Draft`: editable, not live, safe for agent suggestions and incomplete definitions.
- `Ready to publish`: validation passes, required bindings exist, and permission identity is configured.
- `Published`: immutable version is active for execution until replaced or disabled.
- `Paused`: published version remains available for inspection/history but does not trigger new runs.
- `Archived`: no new execution and no further editing; retained for audit and replay references only.

### Trigger authoring

- Users start from a small trigger catalog:
  - record created
  - record updated
  - field changed
  - scheduled
  - manual
- Trigger setup asks for the minimum binding required, such as table, field, or schedule.

### Condition tree authoring

- Conditions are edited in plain-language rule blocks.
- Users can combine `all`, `any`, and `not`.
- Each rule references a field or trigger property that is readable to the workflow identity.
- Hidden or inaccessible fields cannot be selected accidentally.

### Action pipeline authoring

- Actions are stacked in order.
- Each action card declares:
  - target
  - required inputs
  - permission identity
  - retry behavior
- MVP actions:
  - create record
  - update record
  - delete/archive record
  - send webhook
  - enqueue internal job
  - emit notification

### Execution settings

- Workflow runs under an explicit workflow service identity.
- Builders can set:
  - on/off state
  - idempotency mode
  - retry limit
  - timeout class
- Advanced backoff tuning is not exposed in MVP UI.
- Publishing creates a versioned immutable workflow snapshot; later edits resume from a draft derived from the last published version instead of mutating the live definition in place.

### Test UX

- Builder can run a workflow against:
  - a sample trigger payload
  - a selected record
  - a saved fixture
- Test output must show:
  - which conditions passed
  - which actions would run
  - permission failures or redactions

## 10. Agent-Assisted Builder Contract

### Supported agent tasks in MVP

- propose table schema from a natural-language brief
- add fields to an existing table
- generate focused views for named roles
- explain why a user cannot edit a field
- draft a workflow from a business rule
- perform scoped bulk updates with preview

### Safety affordances

- Agent actions are anchored to app/table/view/workflow context.
- The UI always states the agent's visible scope.
- Mutating suggestions require review before commit unless the acting principal explicitly enables direct execution for a safe tool.
- Large or destructive actions require confirmation with impact summary.

### Agent output shape

- `Draft`: suggestion only, no mutation
- `Preview`: structured command plan with expected affected tables, fields, and records
- `Execute`: commit commands and return resulting events

### Non-negotiable constraints

- Agents cannot see fields marked agent-hidden.
- Agents cannot run workflows or updates beyond the user's own effective authority unless a separate service identity is intentionally selected and authorized.
- Agents cannot create arbitrary code or untyped formulas in MVP.
- Agent tools must receive the same redacted field/value surface the caller could obtain through normal product APIs for the same scope.
- Agent suggestions for schema, views, permissions, and workflows are draft artifacts until a human or authorized service identity commits commands.

## 11. Activity and Explainability Contract

- Every schema change, record mutation, workflow run, and agent action appears in activity history.
- Users can inspect:
  - who acted
  - what changed
  - which workflow or agent initiated the change
  - when it happened
- Permission-denied states should be explainable in-product with a human-readable reason rather than a generic forbidden error.

## 12. Explicit Product Non-Goals

- free-form spreadsheet calculations
- realtime collaborative cursor presence
- no-code app page builder
- plugin marketplace
- cross-workspace automations
- advanced BI dashboards
- arbitrary code execution in workflows or agent tools

## 13. Usability Risks and Mitigations

### Risk: permission complexity overwhelms builders

- Mitigation: lead with presets, inheritance summaries, and persona preview.

### Risk: views behave like permissions in user mental models

- Mitigation: label hidden-by-view versus hidden-by-policy distinctly everywhere.

### Risk: workflow authoring becomes too abstract

- Mitigation: start from concrete business sentences and table/view context.

### Risk: agent trust collapses after one surprising bulk action

- Mitigation: keep draft and preview states explicit, with strong confirmation for mutations.

### Risk: required hidden fields break frontline workflows

- Mitigation: block invalid schema combinations at authoring time and offer default/service-filled alternatives.

## 14. Open Questions for Follow-On Design

- Should relation fields support reciprocal back-links in MVP UI or remain one-directional until later?
- Should grouped views support aggregate summaries such as counts only, or counts plus simple numeric totals?
- Should the workflow builder expose "dry run on recent real event" in MVP or defer to fixture-only testing?
- Do we need a separate lightweight mobile operator view in MVP, or is responsive desktop parity sufficient?

## 15. Implementation-Ready Product Decisions

- The app, not the workspace, is the primary builder surface.
- Views are the main operator surface; raw tables remain builder-oriented.
- Status is a first-class field type because operational workflows depend on it.
- Workflow-visible and agent-visible are explicit field toggles and must not inherit implicitly from human visibility.
- Grouped views are actionable queues, not read-only reports.
- Agent assistance is draft/preview/execute, never silent direct mutation by default.
