# CloudTable Studio Saved-View Read Contract

Updated for CLO-3211 on 2026-08-04.

## Endpoint

`GET /v1/tables/{tableId}/views/{viewId}`

Required query parameters:

- `workspaceId`: workspace containing the table and view.

Permission coordinates:

- `principalId`: required when `policyRevision` or `permissionScopeHash` is provided.
- `policyRevision`: finite number. When present, the server resolves the authoritative permission snapshot.
- `permissionScopeHash`: permission scope hash. When present, the server resolves the authoritative permission snapshot.

Pagination parameters:

- `limit`: optional integer from `1` through `500`; default is `100`.
- `cursor`: optional opaque cursor returned from the previous response `pageInfo.nextCursor`.

Invalid `limit`, malformed `cursor`, or inconsistent permission coordinates return `400 bad_request`.

## Response Shape

The read response preserves the existing fields and adds `pageInfo`:

```json
{
  "fields": [],
  "rows": [],
  "groups": [],
  "pageInfo": {
    "hasNextPage": true,
    "limit": 100,
    "nextCursor": "opaque",
    "returnedRowCount": 100
  },
  "view": {
    "allowed": true,
    "consistencyModel": "view_eventual",
    "redactionApplied": false
  }
}
```

`nextCursor` is `null` when `hasNextPage` is false. Clients must treat cursors as opaque and should not construct them.

## Ordering

Rows are filtered first, then sorted by configured saved-view sorts. The server appends deterministic tie breakers by `recordKey` and `recordId`, so cursor pages are stable for a fixed projection and permission snapshot.

Grouped views sort by group field first, then by configured row sorts, then by the same record tie breakers.

## Permission Semantics

Permission decisions are server-authoritative. Clients provide permission coordinates only to identify the snapshot to resolve; clients do not decide field visibility.

Hidden fields are omitted from row `cells` and listed in `hiddenFieldIds`. Redacted fields are returned as redacted values, listed in `redactedFieldIds`, and reflected in `states`.

If a hidden or redacted field is required for a filter, sort, or group constraint, the view read fails closed with `view.allowed: false`, empty rows, and diagnostic metadata instead of leaking the constrained result set.

## Grouped Views

Ungrouped views return page rows in top-level `rows`.

Grouped views return an empty top-level `rows` array and page rows inside `groups[].rows`. Pagination slices across the deterministic flattened group order. A page can include one or more groups depending on the row boundary.

For grouped responses, `groups[].rowCount` is the full count for that group after filters and permissions, not merely the number of rows included on the current page. When `showEmptyGroups` is enabled, configured empty groups remain visible with `rowCount: 0` and empty `rows`.

## Agent Tool Parity

`queryView` accepts the same `cursor` and `limit` inputs and returns the same saved-view payload under `output.view`. This keeps CloudTable Studio behavior consistent across direct product API reads and agent-tool preview reads.
