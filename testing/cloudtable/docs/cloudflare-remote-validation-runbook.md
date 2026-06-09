# CloudTable Cloudflare Remote Validation Runbook

This runbook is the bounded remote trust lane for `CLO-612`.

It exists to prove that the current CloudTable Worker package can boot and exercise real Wrangler-managed Cloudflare resources without reopening product-semantic testing already covered by the deterministic and nightly local suites.

## Scope

Use this runbook only for remote adapter and provisioning trust:

- D1 remote migration
- Worker deploy with Durable Object bindings
- Queue, cron, and R2 binding provisioning trust
- One narrow end-to-end remote smoke flow against the deployed Worker

Do not use this lane to expand semantic assertions beyond the local suites.

## Current repo seam

The current Worker already declares the remote seam in `wrangler.jsonc`:

- `DB` via D1
- `WORKSPACE_CONTROL_DO` and `TABLE_COORDINATOR_DO`
- `EVENT_FANOUT_QUEUE`
- `WORKFLOW_DISPATCH_QUEUE`
- `WORKFLOW_STEP_QUEUE`
- `PROJECTION_MAINTENANCE_QUEUE`
- `DEAD_LETTER_REPROCESSOR_QUEUE`
- cron trigger `* * * * *`
- `ARTIFACTS_BUCKET` via R2

The current Worker also already exposes the narrow smoke surfaces needed for remote trust:

- `GET /healthz`
- `POST /v1/apps`
- `POST /v1/bases/:baseId/tables`

## Prerequisites

You need a Cloudflare-authenticated shell. On 2026-06-09 this workspace did not have one:

```bash
npx wrangler whoami
# You are not authenticated. Please run `wrangler login`.
```

Before running the remote pass:

1. Authenticate Wrangler.
2. Create or confirm the Cloudflare resources named in `wrangler.jsonc`.
3. Replace the placeholder D1 `database_id` in `wrangler.jsonc`.

## Resource bootstrap

Authenticate:

```bash
npx wrangler login
```

Create the D1 database and copy the returned `database_id` into `wrangler.jsonc`:

```bash
npx wrangler d1 create cloudtable
```

Create the queues if they do not already exist:

```bash
npx wrangler queues create cloudtable-event-fanout
npx wrangler queues create cloudtable-workflow-dispatch
npx wrangler queues create cloudtable-workflow-step
npx wrangler queues create cloudtable-projection-maintenance
npx wrangler queues create cloudtable-dead-letter-reprocessor
```

Create the R2 bucket if it does not already exist:

```bash
npx wrangler r2 bucket create cloudtable-artifacts
```

## Remote bootstrap sequence

Apply the Worker schema to the remote D1 database:

```bash
npm run d1:migrate:remote
```

Seed the minimum workspace row required by the current remote smoke route contracts:

```bash
npx wrangler d1 execute cloudtable --remote --file testing/cloudtable/fixtures/cloudflare/remote-smoke-seed.sql
```

Deploy the Worker:

```bash
npx wrangler deploy
```

Export the deployed Worker URL for the smoke commands below:

```bash
export CLOUDTABLE_REMOTE_URL="https://<your-worker>.<your-subdomain>.workers.dev"
```

## Remote smoke commands

Verify the Worker is reachable:

```bash
curl -fsS "$CLOUDTABLE_REMOTE_URL/healthz"
```

Create a base. This is the narrowest useful remote command path because it proves Worker ingress, D1 access, and Durable Object dispatch on real Cloudflare infrastructure:

```bash
curl -fsS \
  -X POST \
  "$CLOUDTABLE_REMOTE_URL/v1/apps" \
  -H 'content-type: application/json' \
  --data @- <<'JSON'
{
  "actor": {
    "mode": "user",
    "principalId": "usr_remote_smoke"
  },
  "commandId": "cmd_remote_base_1",
  "idempotencyKey": "idem_remote_base_1",
  "workspaceId": "ws_remote_smoke",
  "payload": {
    "baseId": "base_remote_smoke",
    "name": "Remote Smoke",
    "slug": "remote-smoke"
  }
}
JSON
```

Create a table in that base:

```bash
curl -fsS \
  -X POST \
  "$CLOUDTABLE_REMOTE_URL/v1/bases/base_remote_smoke/tables" \
  -H 'content-type: application/json' \
  --data @- <<'JSON'
{
  "actor": {
    "mode": "user",
    "principalId": "usr_remote_smoke"
  },
  "commandId": "cmd_remote_table_1",
  "idempotencyKey": "idem_remote_table_1",
  "workspaceId": "ws_remote_smoke",
  "payload": {
    "tableId": "tbl_remote_smoke",
    "name": "Remote Smoke Table",
    "slug": "remote-smoke-table"
  }
}
JSON
```

## What this proves

If the sequence above succeeds, the remote pass has minimally proven:

- Wrangler can deploy the current Worker bundle.
- Remote D1 migration works against the declared `DB` binding.
- Durable Object namespaces are provisioned and reachable from command ingress.
- The deployed Worker can serve a real end-to-end create-base and create-table flow without local harness shims.

Queue, cron, and R2 coverage in this lane is provisioning trust rather than semantic coverage. For this issue, treat successful deploy plus declared binding availability as sufficient unless a deploy-time binding error surfaces.

## Expected blocker conditions

Stop and record a blocker if any of the following occur:

- `wrangler whoami` is unauthenticated.
- `wrangler d1 create cloudtable` succeeds but `database_id` is not copied into `wrangler.jsonc`.
- `npm run d1:migrate:remote` fails against the remote D1 binding.
- `npx wrangler deploy` reports missing queue, Durable Object, cron, or R2 configuration.
- The deployed Worker answers `/healthz` but the create-base or create-table route fails on remote bindings.

## Closing comment checklist

When closing the remote pass, record:

- the exact authentication state used
- whether `wrangler.jsonc` needed resource ID changes
- the commands executed
- the observed outcome for migration, deploy, `/healthz`, base create, and table create
- any remaining external blocker, with owner and exact next action
