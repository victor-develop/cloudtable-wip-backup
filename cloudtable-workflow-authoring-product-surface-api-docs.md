# CloudTable Workflow Recipe Authoring Product Surface and API Docs

Date: 2026-06-23
Issue: CLO-2320, CLO-2719
Goal: Identity and reactive data workflows
Links: CLO-2318, CLO-2319, CLO-2716

## Disposition

CloudTable should move the identity/reactive workflow milestone from backend
reconciliation into a builder-facing recipe authoring surface. The first
surface is a table-context recipe drawer backed by the existing catalog,
preview, create, and optional publish-on-create endpoints for `direct_sync` and
`grouped_rollup`.

This is not a general workflow builder. It is a guided recipe lane for two
already-supported business outcomes:

- direct sync: keep a target field on related records in sync when a source
  record field changes
- grouped rollup: recompute one or more rollup fields on related target records
  when contributing source fields or relation fields change

## Product Surface

### Entry points

The MVP entry point is table-local:

- Table toolbar: `Workflows` -> `Add recipe`
- Field context menu for relation, status, select, text, number, computed rollup,
  and user fields: `Use in workflow recipe`
- Empty workflow tab state in an app: `Create from table recipe`

The app-level workflow tab can list existing workflows, but recipe authoring
starts from a table because both supported recipes need concrete table and field
context.

### Catalog read path

The UI reads the workspace catalog before showing recipe cards:

`GET /v1/workspaces/{workspaceId}/workflow-recipes`

The catalog is the source of truth for:

- available `recipeTypes`
- each recipe description
- fixed trigger id, currently `field_changed`
- required input ids
- allowed status values: `draft`, `published`, `paused`
- match strategies: `single_relation`, `value_match`
- preview and publish route metadata
- maintenance kinds and route metadata
- aggregate operation choices for `grouped_rollup`
- workflow operator manifests used by each recipe

Catalog permission errors should block authoring and explain that the user lacks
workflow authoring permission for the workspace.

### Recipe cards

Show two cards in the first release:

- `Sync related field`
  - recipeType: `direct_sync`
  - copy: "When a field changes, copy its value to a field on linked records."
  - best for status mirroring, account rollups sourced from child records, owner
    propagation, and simple cross-table consistency
- `Grouped rollup`
  - recipeType: `grouped_rollup`
  - copy: "When child records change, recompute a summary field on each related
    parent record."
  - best for counts, sums, maximums, and averages over related records

Each card should show whether publish will enqueue maintenance:

- direct sync: backfill/recompute via sync maintenance
- grouped rollup: backfill/recompute via aggregate maintenance

### Direct Sync Form

Required inputs:

- `name`
- `workflowId`, generated client-side or server-side before create
- `tableId`, from the current table context
- `syncSourceFieldId`, the source table field whose value is copied
- `relatedSourceFieldId`, the relation or match field that resolves target
  records
- `syncTargetFieldId`, the target table field to write
- optional `businessRule`, used for human-readable preview and future assisted
  drafting
- optional `matchStrategy`, defaulting to `single_relation` when the source field
  is a relation

Field picker constraints:

- Source field must be workflow-readable and compatible with the target field.
- Related source field must identify target records through `single_relation` or
  `value_match`.
- `single_relation` uses a relation field on the source row and writes every
  resolved target record. `value_match` uses `relatedSourceFieldId` on the source
  row and `relatedTargetFieldId` on the target table; target records match when
  those normalized values compare equal.
- Target field must be workflow-writable and must not be computed read-only.
- If source and target field types differ, block create unless backend preview
  returns a supported coercion in the proposal metadata.

Preview summary:

- trigger table and fields
- related table resolver alias and target table
- action operator `sync_related_field`
- fields that will be read and written
- maintenance behavior after publish

### Grouped Rollup Form

Required inputs:

- `name`
- `workflowId`, generated client-side or server-side before create
- `tableId`, from the current table context
- `rollupFieldIds`, one or more computed rollup fields on the related target
  table
- optional `businessRule`
- optional aggregate operation selection when multiple operations are compatible
  with a rollup field

Field picker constraints:

- Each rollup target must be a computed rollup-style field exposed by the field
  registry and workflow metadata.
- Each rollup target must resolve a related target table and contributing source
  fields.
- Supported operations come from catalog `aggregateOperations`: count, sum, max,
  and average in the current backend contract.
- Source fields used by the aggregate must be workflow-readable; target rollup
  fields must be workflow-writable by service identity even if human users see
  them as read-only.

Preview summary:

- trigger table and changed source fields
- related table resolver aliases
- aggregate definitions by target field and operation id
- action operator `set_cell`
- maintenance behavior after publish

### Preview Step

Both recipe forms must call:

`POST /v1/tables/{tableId}/workflow-recipes/preview`

The preview step is required before create. It produces the exact command
proposal that create will submit. The UI should render:

- workflow name
- recipe type
- generated trigger and action structure
- fields read by the workflow
- fields written by the workflow
- related table resolver details
- aggregate definitions for grouped rollup
- validation diagnostics and permission failures
- whether publish will be immediate or draft-only

Preview does not mutate product state. The submit button stays disabled until
the latest form state has a successful preview.

### Create and Publish

Create uses:

`POST /v1/tables/{tableId}/workflow-recipes`

The default UX should create as draft. Include a separate `Create and publish`
action only when preview has no warnings and the acting principal has publish
permission.

Create request behavior:

- Always include `commandId` and `idempotencyKey`.
- Include `publish: true`, `publishCommandId`, and `publishIdempotencyKey` only
  for `Create and publish`.
- If `publish` is false or omitted, the response status is `draft`.
- If `publish` is true and publish succeeds, the response status is `published`.
- After publish, show the queued maintenance message from catalog metadata.

After create:

- Draft workflow opens the workflow detail screen with a `Publish` action.
- Published workflow opens the workflow detail screen at the `Runs and
  maintenance` section.
- Activity history should show create, optional publish, and maintenance enqueue
  when available.

## Validation and Error States

Client-side validation:

- missing required input
- field id no longer exists in current schema metadata
- incompatible source/target field category known from field manifests
- no relation or value-match path to the target table
- duplicate rollup field ids
- publish requested without publish permission in the active permission snapshot

Server-returned validation and errors:

- `400 invalid_request`: malformed body, unknown recipe type, missing required
  recipe input, unsupported match strategy
- `403 forbidden`: caller cannot read catalog, preview workflow, create
  workflow, publish workflow, read involved fields, or write involved target
  fields
- `404 not_found`: workspace, table, field, or workflow target no longer exists
- `409 idempotency_conflict`: reused idempotency key with different command
  payload
- `422 validation_failed`: schema-compatible request that cannot produce a valid
  workflow proposal, such as field type mismatch, target write mismatch, missing
  service identity metadata, or unsupported aggregate operation
- `500 internal_error`: retryable platform failure; keep the form state and allow
  retry with a new idempotency key only if no receipt was created

UX handling:

- Inline field errors attach to the relevant picker.
- Cross-field errors appear in a preview diagnostics panel.
- Permission errors include the object type and action when the backend returns
  enough detail; otherwise use a generic "workflow authoring permission required"
  message.
- Stale schema errors offer `Refresh schema` before allowing another preview.

## API Reference

These endpoints are the bounded authoring API from CLO-2320. They depend on the
workflow authoring and permission lanes from CLO-2319, and they unblock the
frontend implementation tracked by CLO-2318 successors.

### Permission Snapshot Inputs

The current ingress examples use the same permission snapshot shape on all three
endpoints:

- `principalId`: optional when an authenticated session can resolve a workspace
  principal; required for service/agent callers and examples without cookies
- `permissionScopeHash`: required by the agent-tool permission snapshot lookup
- `policyRevision`: required by the agent-tool permission snapshot lookup
- `workspaceId`: required on preview and create bodies; supplied as the catalog
  path parameter on catalog reads

The snapshot must include workflow command permissions for the action being
taken. `workflow.create` is required for create, `workflow.publish` is required
for publish-on-create, and catalog/preview reads must be allowed to inspect the
recipe catalog and involved fields. Field-level snapshot entries for the recipe
inputs must mark involved fields as workflow-readable, and target fields as
workflow-writable by the service identity.

Example direct-sync snapshot fields:

```json
{
  "commandTypes": ["workflow.create", "workflow.publish"],
  "fields": {
    "fld_ticket_account": {
      "fieldType": "relation.record",
      "read": "visible",
      "workflow": true,
      "write": true
    },
    "fld_ticket_status": {
      "fieldType": "text.single_line",
      "read": "visible",
      "workflow": true,
      "write": true
    },
    "fld_account_status": {
      "fieldType": "text.single_line",
      "read": "visible",
      "workflow": true,
      "write": true
    }
  },
  "policyRevision": 53,
  "principalId": "agt_sync_workflow_execute",
  "scopeHash": "scope:table:tbl_1",
  "workspaceId": "ws_1"
}
```

Example grouped-rollup snapshot fields:

```json
{
  "commandTypes": ["workflow.create", "workflow.publish"],
  "fields": {
    "fld_ticket_account": {
      "fieldType": "relation.record",
      "read": "visible",
      "workflow": true,
      "write": true
    },
    "fld_ticket_amount": {
      "fieldType": "number.decimal",
      "read": "visible",
      "workflow": true,
      "write": true
    },
    "fld_account_revenue_rollup": {
      "fieldType": "computed.readonly",
      "read": "visible",
      "workflow": true,
      "write": true
    }
  },
  "policyRevision": 52,
  "principalId": "agt_rollup_workflow_execute",
  "scopeHash": "scope:table:tbl_1",
  "workspaceId": "ws_1"
}
```

### GET /v1/workspaces/{workspaceId}/workflow-recipes

Reads the canonical authoring catalog for a workspace. The UI must call this
before rendering recipe cards because it is the source of truth for supported
recipe types, trigger ids, input ids, route templates, status values,
maintenance behavior, aggregate operations, and workflow operator manifests.

Query parameters:

- `principalId`: acting principal id, optional only when the request session can
  resolve a workspace principal
- `permissionScopeHash`: active permission snapshot scope hash
- `policyRevision`: active permission policy revision

Success response:

```json
{
  "catalog": {
    "recipeTypes": ["direct_sync", "grouped_rollup"],
    "recipes": {
      "direct_sync": {
        "description": "Author a field_changed workflow that syncs one source field into related target records.",
        "fixedTriggerId": "field_changed",
        "maintenance": {
          "kinds": ["backfill", "recompute"],
          "queuedMessage": "Sync maintenance is queued after publish and runs asynchronously.",
          "route": {
            "method": "POST",
            "pathTemplate": "/v1/workflows/{workflowId}/sync-maintenance"
          }
        },
        "matchStrategies": ["single_relation", "value_match"],
        "previewRoute": {
          "method": "POST",
          "pathTemplate": "/v1/tables/{tableId}/workflow-recipes/preview"
        },
        "publishRoute": {
          "method": "POST",
          "pathTemplate": "/v1/workflows/{workflowId}/publish"
        },
        "recipeType": "direct_sync",
        "requiredInputIds": [
          "tableId",
          "workflowId",
          "name",
          "syncSourceFieldId",
          "syncTargetFieldId",
          "relatedSourceFieldId"
        ],
        "statusValues": ["draft", "published", "paused"],
        "workflowOperators": [
          {
            "id": "sync_related_field",
            "kind": "action"
          }
        ]
      },
      "grouped_rollup": {
        "aggregateOperations": [
          { "id": "count_records" },
          { "id": "sum_numbers" },
          { "id": "max_number" },
          { "id": "average_numbers" }
        ],
        "description": "Author a field_changed workflow that recomputes grouped rollup fields on related target records.",
        "fixedTriggerId": "field_changed",
        "maintenance": {
          "kinds": ["backfill", "recompute"],
          "queuedMessage": "Rollup maintenance is queued after publish and runs asynchronously.",
          "route": {
            "method": "POST",
            "pathTemplate": "/v1/workflows/{workflowId}/aggregate-maintenance"
          }
        },
        "matchStrategies": ["single_relation", "value_match"],
        "previewRoute": {
          "method": "POST",
          "pathTemplate": "/v1/tables/{tableId}/workflow-recipes/preview"
        },
        "publishRoute": {
          "method": "POST",
          "pathTemplate": "/v1/workflows/{workflowId}/publish"
        },
        "recipeType": "grouped_rollup",
        "requiredInputIds": ["tableId", "workflowId", "name", "rollupFieldIds"],
        "statusValues": ["draft", "published", "paused"],
        "workflowOperators": [
          {
            "id": "set_cell",
            "kind": "action"
          }
        ]
      }
    }
  },
  "permissionScope": {
    "policyRevision": 44,
    "principalId": "ops_workflow_recipe_catalog",
    "scopeHash": "scope:workspace",
    "workspaceId": "ws_1"
  },
  "workspaceId": "ws_1"
}
```

Catalog errors:

| Status | Code | Cause | Client behavior |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Missing or malformed permission query input. | Keep the drawer closed and refresh auth context. |
| 403 | `forbidden` | Principal cannot read the recipe catalog or the permission snapshot is stale/insufficient. | Show a workspace-level workflow authoring permission message. |
| 404 | `not_found` | Workspace does not exist or is not visible to the principal. | Return to the workspace/table picker. |
| 500 | `internal_error` | Catalog or permission lookup failed. | Allow retry without changing local form state. |

### POST /v1/tables/{tableId}/workflow-recipes/preview

Validates recipe inputs and returns the exact non-mutating `workflow.create`
command proposal that create will execute. Preview calls the agent-tool preview
ingress with `toolId: "proposeWorkflow"`.

Common body fields:

| Field | Required | Notes |
| --- | --- | --- |
| `workspaceId` | yes | Workspace containing the table and workflow. |
| `principalId` | session-dependent | Required for service/agent callers. |
| `permissionScopeHash` | yes | Active snapshot scope hash. |
| `policyRevision` | yes | Active snapshot policy revision. |
| `recipeType` | yes | `direct_sync` or `grouped_rollup`. |
| `workflowId` | yes | Stable workflow id generated before preview. |
| `name` | yes | Workflow display name. |
| `businessRule` | no | Human-readable rule; backend supplies a recipe default when omitted. |

Direct-sync body fields:

| Field | Required | Notes |
| --- | --- | --- |
| `syncSourceFieldId` | yes | Field on `{tableId}` whose value is copied. |
| `relatedSourceFieldId` | yes | Relation or match field on `{tableId}` that resolves target records. |
| `syncTargetFieldId` | yes | Target table field to write. |
| `relatedTargetFieldId` | no | Optional target-side match field for value-match style resolvers. |

Grouped-rollup body fields:

| Field | Required | Notes |
| --- | --- | --- |
| `rollupFieldIds` | yes | Non-empty array of computed rollup target field ids. |

Direct-sync preview example:

```json
{
  "businessRule": "Sync ticket status into the linked account status.",
  "name": "Ticket status sync",
  "permissionScopeHash": "scope:table:tbl_1",
  "policyRevision": 53,
  "principalId": "agt_sync_workflow_execute",
  "recipeType": "direct_sync",
  "relatedSourceFieldId": "fld_ticket_account",
  "syncSourceFieldId": "fld_ticket_status",
  "syncTargetFieldId": "fld_account_status",
  "workflowId": "wf_ticket_status_sync_execute",
  "workspaceId": "ws_1"
}
```

Direct-sync preview response excerpt:

```json
{
  "output": {
    "command": {
      "payload": {
        "definition": {
          "actions": [
            {
              "input": {
                "resolverAlias": "sync_fld_account_status",
                "sourceFieldId": "fld_ticket_status",
                "targetFieldId": "fld_account_status"
              },
              "operatorId": "sync_related_field"
            }
          ],
          "metadata": {
            "relatedTableResolvers": [
              {
                "alias": "sync_fld_account_status",
                "sourceFieldId": "fld_ticket_account",
                "strategy": "single_relation",
                "targetTableId": "tbl_accounts"
              }
            ]
          },
          "trigger": {
            "match": {
              "fieldIds": ["fld_ticket_status", "fld_ticket_account"],
              "tableId": "tbl_1"
            },
            "operatorId": "field_changed"
          }
        }
      }
    },
    "proposal": {
      "metadata": {
        "relatedTableResolvers": [
          {
            "alias": "sync_fld_account_status",
            "sourceFieldId": "fld_ticket_account",
            "strategy": "single_relation",
            "targetTableId": "tbl_accounts"
          }
        ]
      }
    }
  }
}
```

Grouped-rollup preview example:

```json
{
  "businessRule": "Roll ticket amount into account revenue.",
  "name": "Ticket revenue rollup",
  "permissionScopeHash": "scope:table:tbl_1",
  "policyRevision": 52,
  "principalId": "agt_rollup_workflow_execute",
  "recipeType": "grouped_rollup",
  "rollupFieldIds": ["fld_account_revenue_rollup"],
  "workflowId": "wf_ticket_revenue_rollup_execute",
  "workspaceId": "ws_1"
}
```

Grouped-rollup preview response excerpt:

```json
{
  "output": {
    "command": {
      "payload": {
        "definition": {
          "actions": [
            {
              "input": {
                "fieldId": {
                  "path": "relatedTables.rollup_fld_account_revenue_rollup.row.fields.revenue_sum.fieldId"
                },
                "recordId": {
                  "path": "relatedTables.rollup_fld_account_revenue_rollup.row.recordId"
                },
                "tableId": {
                  "path": "relatedTables.rollup_fld_account_revenue_rollup.tableId"
                },
                "value": {
                  "path": "cell.value"
                }
              },
              "operatorId": "set_cell"
            }
          ],
          "metadata": {
            "aggregateDefinitions": [
              {
                "alias": "fld_account_revenue_rollup",
                "operationId": "sum_numbers",
                "targetFieldId": "fld_account_revenue_rollup"
              }
            ]
          },
          "trigger": {
            "match": {
              "fieldIds": ["fld_ticket_account", "fld_ticket_amount"],
              "tableId": "tbl_1"
            },
            "operatorId": "field_changed"
          }
        }
      }
    },
    "proposal": {
      "metadata": {
        "aggregateDefinitions": [
          {
            "alias": "fld_account_revenue_rollup",
            "groupingSource": {
              "kind": "related_record",
              "resolverAlias": "rollup_fld_account_revenue_rollup"
            },
            "operationId": "sum_numbers",
            "sourceRelationPath": "relatedTables.rollup_fld_account_revenue_rollup",
            "targetFieldId": "fld_account_revenue_rollup"
          }
        ],
        "relatedTableResolvers": [
          {
            "alias": "rollup_fld_account_revenue_rollup",
            "sourceFieldId": "fld_ticket_account",
            "strategy": "single_relation",
            "targetTableId": "tbl_accounts"
          }
        ],
        "rollupFieldIds": ["fld_account_revenue_rollup"]
      }
    }
  }
}
```

Preview errors:

| Status | Code | Cause | Client behavior |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Body is not JSON; `workspaceId`, `workflowId`, `name`, or required recipe fields are missing; `recipeType` is not supported; `rollupFieldIds` is empty or contains non-strings. | Attach inline field errors and keep create disabled. |
| 403 | `forbidden` | Principal lacks preview/workflow permission, cannot read involved fields, or cannot write target fields. | Show permission diagnostics and keep form state. |
| 404 | `not_found` | Table, field, workspace, or resolved target table no longer exists. | Offer schema refresh before retry. |
| 422 | `validation_failed` | Request is well-formed but cannot produce a valid proposal, such as field mismatch, no resolver path, missing service identity metadata, or unsupported aggregate operation. | Render diagnostics in the preview panel. |
| 500 | `internal_error` | Agent-tool preview or registry lookup failed. | Allow retry with the same form state. |

### POST /v1/tables/{tableId}/workflow-recipes

Creates a workflow from a recipe payload and can immediately publish it. Create
first rebuilds the same proposal used by preview, then executes the generated
`workflow.create` command through the agent-tool execute ingress. The body must
repeat the preview fields; the server does not accept a detached preview token.

Additional mutation fields:

| Field | Required | Notes |
| --- | --- | --- |
| `commandId` | yes | Id for the generated `workflow.create` command. |
| `idempotencyKey` | yes | Idempotency key for create execution. |
| `publish` | no | `true` or an object. Omit/false to create a draft. |
| `publishCommandId` | when `publish: true` | Top-level publish command id. |
| `publishIdempotencyKey` | when `publish: true` | Top-level publish idempotency key. |
| `publish.commandId` | when `publish` is an object | Nested publish command id. |
| `publish.idempotencyKey` | when `publish` is an object | Nested publish idempotency key. |

Status transitions:

- successful create with no publish request returns `status: "draft"`
- successful create plus successful publish returns `status: "published"`
- successful create plus failed publish returns `status: "publish_rejected"` with
  the publish response body included for diagnostics
- failed create returns `status: "rejected"` and does not attempt publish

Draft create example:

```json
{
  "businessRule": "Sync ticket status into the linked account status.",
  "commandId": "cmd_create_sync_workflow_recipe",
  "idempotencyKey": "idem_create_sync_workflow_recipe",
  "name": "Ticket status sync",
  "permissionScopeHash": "scope:table:tbl_1",
  "policyRevision": 53,
  "principalId": "agt_sync_workflow_execute",
  "recipeType": "direct_sync",
  "relatedSourceFieldId": "fld_ticket_account",
  "syncSourceFieldId": "fld_ticket_status",
  "syncTargetFieldId": "fld_account_status",
  "workflowId": "wf_ticket_status_sync_execute",
  "workspaceId": "ws_1"
}
```

Draft create response excerpt:

```json
{
  "create": {
    "result": {
      "accepted": true
    }
  },
  "diagnostics": [],
  "metadata": {
    "relatedTableResolvers": [
      {
        "alias": "sync_fld_account_status",
        "sourceFieldId": "fld_ticket_account",
        "strategy": "single_relation",
        "targetTableId": "tbl_accounts"
      }
    ]
  },
  "permissionScope": {
    "policyRevision": 53,
    "principalId": "agt_sync_workflow_execute",
    "scopeHash": "scope:table:tbl_1",
    "workspaceId": "ws_1"
  },
  "recipeType": "direct_sync",
  "status": "draft",
  "workflowId": "wf_ticket_status_sync_execute"
}
```

Publish-on-create example:

```json
{
  "businessRule": "Roll ticket amount into account revenue.",
  "commandId": "cmd_create_rollup_workflow_recipe",
  "idempotencyKey": "idem_create_rollup_workflow_recipe",
  "name": "Ticket revenue rollup",
  "permissionScopeHash": "scope:table:tbl_1",
  "policyRevision": 52,
  "principalId": "agt_rollup_workflow_execute",
  "publish": true,
  "publishCommandId": "cmd_publish_rollup_workflow_recipe",
  "publishIdempotencyKey": "idem_publish_rollup_workflow_recipe",
  "recipeType": "grouped_rollup",
  "rollupFieldIds": ["fld_account_revenue_rollup"],
  "workflowId": "wf_ticket_revenue_rollup_execute",
  "workspaceId": "ws_1"
}
```

Nested publish object is also accepted:

```json
{
  "publish": {
    "commandId": "cmd_google_session_recipe_publish",
    "idempotencyKey": "idem_google_session_recipe_publish"
  }
}
```

Published create response excerpt:

```json
{
  "create": {
    "result": {
      "accepted": true
    }
  },
  "diagnostics": [],
  "publish": {
    "result": {
      "accepted": true
    }
  },
  "recipeType": "grouped_rollup",
  "status": "published",
  "workflowId": "wf_ticket_revenue_rollup_execute"
}
```

Idempotency rules:

- `commandId` and `idempotencyKey` are mandatory for create.
- Publish ids are mandatory only when publish is requested.
- Retry a network timeout with the same `commandId` and `idempotencyKey` until a
  terminal create receipt is observed.
- Do not reuse an idempotency key with a changed payload. The command ingress
  should return `409 idempotency_conflict`.
- If create succeeds and publish fails, retry publish through the workflow
  publish route or call create again with the same create idempotency key only if
  the product has confirmed the existing create receipt.

Maintenance behavior:

- `direct_sync` publish queues sync maintenance for `backfill`/`recompute` via
  `/v1/workflows/{workflowId}/sync-maintenance`.
- `grouped_rollup` publish queues aggregate maintenance for
  `backfill`/`recompute` via
  `/v1/workflows/{workflowId}/aggregate-maintenance`.
- Maintenance is asynchronous. The create response reports publish acceptance,
  not maintenance completion.

### Recipe Contract Summary

Use `direct_sync` when a source record field should be copied into matching
target records after `field_changed`. The generated workflow uses the
`sync_related_field` action and stores sync dependency metadata so later
backfill/recompute can target all sync definitions or selected sync aliases.

Use `grouped_rollup` when a target computed rollup field should be recalculated
from grouped source rows after relation or operand fields change. The generated
workflow uses `set_cell`, stores aggregate definitions, and exposes aggregate
operation ids through the catalog.

Current aggregate operation ids are:

| Operation id | Operand | Result |
| --- | --- | --- |
| `count_records` | none | Count of grouped source rows. |
| `sum_numbers` | numeric source field | Sum of finite numeric operand values. |
| `max_number` | numeric source field | Maximum finite numeric operand value, or `null`. |
| `average_numbers` | numeric source field | Arithmetic mean of finite numeric operand values, or `null`. |

Alias rules:

- Aggregate aliases are the generated aggregate `alias` values returned in
  preview/create metadata and dependency inspection. For recipe-created rollups,
  the alias is currently the rollup field id.
- Sync aliases are derived as
  `{resolverAlias}:{sourceFieldId}:{targetFieldId}` and are returned by
  dependency inspection.
- Manual maintenance can omit alias filters to target every matching dependency
  in the published workflow version.

Create errors:

| Status | Code | Cause | Client behavior |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Body is not JSON; required preview fields are missing; `commandId`/`idempotencyKey` is missing; publish ids are missing when publish is requested. | Keep the form open and fix client payload generation. |
| 403 | `forbidden` | Permission snapshot changed between preview and create, or principal lacks create/publish/field write permission. | Refresh permissions and require a new preview before retry. |
| 404 | `not_found` | Workspace, table, field, workflow, or publish target no longer exists. | Refresh schema and route user back to the workflow list if needed. |
| 409 | `idempotency_conflict` | Idempotency key was reused with a different command payload. | Generate a new command/idempotency pair only after confirming no workflow was created. |
| 422 | `validation_failed` | Rebuilt proposal is invalid, create command is rejected, service identity metadata is missing, or aggregate operation is unsupported. | Render diagnostics and require another preview. |
| 500 | `internal_error` | Proposal, create execution, publish execution, or maintenance enqueue failed unexpectedly. | Preserve form state; retry according to receipt visibility. |

### GET /v1/workflows/{workflowId}/dependencies

Reads the dependency index and current maintenance observability state for a
workflow. Use this endpoint after publish, before manual maintenance, and in a
workflow detail "Dependencies" or "Maintenance" panel.

Query parameters:

| Field | Required | Notes |
| --- | --- | --- |
| `workspaceId` | yes | Workspace containing the workflow. |
| `principalId` | session-dependent | Required for service/agent callers. |
| `permissionScopeHash` | yes | Active snapshot scope hash. |
| `policyRevision` | yes | Active snapshot policy revision. |

Success response excerpt:

```json
{
  "workflowId": "wf_ticket_revenue_rollup_execute",
  "dependencies": [
    {
      "alias": "fld_account_revenue_rollup",
      "dependencyFieldIds": ["fld_ticket_account", "fld_ticket_amount"],
      "definition": {
        "operationId": "sum_numbers",
        "targetFieldId": "fld_account_revenue_rollup"
      },
      "kind": "aggregate",
      "sourceTableId": "tbl_1",
      "status": "published",
      "targetTableId": "tbl_accounts",
      "triggerTableId": "tbl_1",
      "updatedAt": "2026-06-28T00:00:00.000Z",
      "workflowVersionId": "wf_ticket_revenue_rollup_execute:v1"
    }
  ],
  "backfillJobs": [
    {
      "attemptCount": 0,
      "chunkSize": 100,
      "completedAt": null,
      "cursor": null,
      "dependencyAlias": "fld_account_revenue_rollup",
      "dependencyKind": "aggregate",
      "id": "backfill:wf_ticket_revenue_rollup_execute:v1:aggregate:fld_account_revenue_rollup:workflow_published",
      "lastError": null,
      "processedCount": 0,
      "reason": "workflow_published",
      "status": "queued",
      "updatedAt": "2026-06-28T00:00:00.000Z",
      "workflowVersionId": "wf_ticket_revenue_rollup_execute:v1"
    }
  ]
}
```

Dependency `kind` values include `trigger`, `resolver`, `sync`, `aggregate`,
and `lookup` when present in the published workflow definition. `dependencyFieldIds`
are the fields that can cause the dependency to refresh.

`workflow_backfill_jobs` is the current observability and idempotency state for
maintenance work. It records the dependency alias, reason, queue status, cursor,
processed count, attempts, and completion/error fields. It does not yet provide
resumable chunk scheduling; resumable chunk execution is tracked separately.

### POST /v1/workflows/{workflowId}/aggregate-maintenance

Enqueues grouped-rollup aggregate maintenance for a published workflow. The
workflow must include aggregate dependency metadata and valid service identity
metadata.

Body fields:

| Field | Required | Notes |
| --- | --- | --- |
| `workspaceId` | yes | Workspace containing the workflow. |
| `principalId` | session-dependent | Required for service/agent callers. |
| `permissionScopeHash` | yes | Active snapshot scope hash. |
| `policyRevision` | yes | Active snapshot policy revision. |
| `kind` | yes | `backfill` or `recompute`. |
| `requestId` | no | Idempotency key for this maintenance request. |
| `idempotencyKey` | no | Fallback idempotency key when `requestId` is absent. |
| `aggregateAliases` | no | Non-empty string array. Omit to target every aggregate definition. |
| `changedFieldIds` | no | Recompute context; non-empty string array when provided. |
| `recordId` | no | Recompute context for a selected source record. |
| `reason` | no | Backfill reason; defaults to `manual`. |

Example:

```json
{
  "aggregateAliases": ["fld_account_revenue_rollup"],
  "kind": "backfill",
  "permissionScopeHash": "scope:table:tbl_1",
  "policyRevision": 52,
  "principalId": "agt_rollup_workflow_execute",
  "reason": "manual_admin_backfill",
  "requestId": "manual-rollup-backfill-1",
  "workspaceId": "ws_1"
}
```

Success response (`202 Accepted`):

```json
{
  "aggregateAliases": ["fld_account_revenue_rollup"],
  "kind": "backfill",
  "requestId": "manual-rollup-backfill-1",
  "status": "enqueued",
  "workflowId": "wf_ticket_revenue_rollup_execute",
  "workflowVersionId": "wf_ticket_revenue_rollup_execute:v1"
}
```

### POST /v1/workflows/{workflowId}/sync-maintenance

Enqueues direct-sync maintenance for a published workflow. The workflow must
include sync dependency metadata and valid service identity metadata.

Body fields:

| Field | Required | Notes |
| --- | --- | --- |
| `workspaceId` | yes | Workspace containing the workflow. |
| `principalId` | session-dependent | Required for service/agent callers. |
| `permissionScopeHash` | yes | Active snapshot scope hash. |
| `policyRevision` | yes | Active snapshot policy revision. |
| `kind` | yes | `backfill` or `recompute`. |
| `requestId` | no | Idempotency key for this maintenance request. |
| `idempotencyKey` | no | Fallback idempotency key when `requestId` is absent. |
| `syncAliases` | no | Non-empty string array. Omit to target every sync definition. |
| `changedFieldIds` | no | Recompute context; non-empty string array when provided. |
| `recordId` | no | Recompute context for a selected source record. |
| `reason` | no | Backfill reason; defaults to `manual`. |

Example:

```json
{
  "kind": "backfill",
  "permissionScopeHash": "scope:table:tbl_1",
  "policyRevision": 53,
  "principalId": "agt_sync_workflow_execute",
  "requestId": "manual-sync-backfill-1",
  "syncAliases": ["sync_fld_account_status:fld_ticket_status:fld_account_status"],
  "workspaceId": "ws_1"
}
```

Success response (`202 Accepted`):

```json
{
  "kind": "backfill",
  "requestId": "manual-sync-backfill-1",
  "status": "enqueued",
  "syncAliases": ["sync_fld_account_status:fld_ticket_status:fld_account_status"],
  "workflowId": "wf_ticket_status_sync_execute",
  "workflowVersionId": "wf_ticket_status_sync_execute:v1"
}
```

Manual maintenance errors:

| Status | Cause | Client behavior |
| --- | --- | --- |
| 400 | Body is not JSON; `kind` is not `backfill`/`recompute`; alias arrays contain non-strings; workflow has no matching aggregate/sync metadata; requested alias is unknown; workflow is paused; service identity metadata is invalid. | Show diagnostics and refresh dependency inspection before retry. |
| 403 | Permission snapshot does not allow workflow operations access. | Refresh permissions and disable maintenance controls. |
| 404 | Workflow does not exist in the requested workspace. | Return to workflow list. |
| 409 | `requestId`/`idempotencyKey` was already accepted for the workflow maintenance scope. | Treat as already submitted and inspect dependencies/backfill jobs for status. |
| 500 | Queue or persistence failure. | Preserve form state and retry with the same request id until receipt is known. |

## Dedicated UX Work Needed

A dedicated UX owner should own wireframes before frontend implementation.
The product contract is bounded enough for engineering, but the following design
decisions affect usability and should not be improvised in frontend code:

- exact table-toolbar and field-menu entry points
- two-step preview/confirm interaction
- field compatibility picker states
- preview diagnostics layout
- "Create draft" versus "Create and publish" affordance
- maintenance queued state after publish
- workflow detail handoff after draft or publish

Current company roster has no dedicated UX/design agent. The follow-up should be
created as a product-owned UX specification task and escalated to CTO/CEO if a
true UX specialist is required.

## Implementation-Ready Follow-Ups

The scope is bounded enough for three next issues:

1. Product/UX wireframe spec for the table-context recipe authoring drawer.
2. Backend/API documentation for the recipe, dependency, and maintenance
   endpoints listed above.
3. Frontend implementation of the recipe catalog, preview, create, and optional
   publish flow, blocked by the UX wireframe spec and API docs.

Do not create another backend reconciliation task for identity/reactive workflow
capability from CLO-2320. CLO-2319 established that the relevant backend lane is
already present; CLO-2320 moves the work to product surface and API
documentation.

## Verification

Checked against:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/core/aggregates/registry.ts`
- `src/runtime/worker.ts`
- `src/runtime/workflow-operations.ts`
- `src/runtime/workflow-runtime.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `cloudtable-product-contract.md`
- `cloudtable-workflow-runtime-and-permission-spec.md`
- recent CLO-2319 successor reconciliation notes showing the backend recipe lane
  as the source of truth

No runtime code changes were made for this issue.
