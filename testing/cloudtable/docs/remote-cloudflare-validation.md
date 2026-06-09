# CloudTable Remote Cloudflare Validation

This lane exists to prove Cloudflare adapter and provisioning trust only.
Keep semantic product assertions in the deterministic suites and use the remote lane only for resource bootstrap, migration, deploy, and one narrow health check.

## What this proves

- Wrangler can bundle the worker with the declared D1, Durable Object, Queue, cron, and R2 bindings.
- The remote D1 migration path works against the configured account-backed database.
- A real deploy can attach the declared bindings and expose the worker health endpoint.

## Current prerequisites

- Cloudflare account access that can manage Workers, D1, Queues, Durable Objects, and R2 for the target account.
- Wrangler authentication via `wrangler login` or equivalent account-scoped credentials.
- `wrangler.jsonc` updated with the real D1 `database_id` instead of the placeholder value.

## Preflight

Run the checked-in preflight first:

```bash
node scripts/cloudflare-remote-preflight.mjs
```

The preflight does three things:

- statically validates the `wrangler.jsonc` binding contract against the runtime expectations
- runs `wrangler deploy --dry-run` to prove bundle-time binding resolution
- fails fast if Wrangler is unauthenticated or the D1 `database_id` is still a placeholder

## Remote provisioning

Create any missing account resources before the first remote deploy:

```bash
npx wrangler d1 create cloudtable
npx wrangler queues create cloudtable-event-fanout
npx wrangler queues create cloudtable-workflow-dispatch
npx wrangler queues create cloudtable-workflow-step
npx wrangler queues create cloudtable-projection-maintenance
npx wrangler queues create cloudtable-dead-letter-reprocessor
npx wrangler r2 bucket create cloudtable-artifacts
```

After creating the D1 database, copy the returned `database_id` into `wrangler.jsonc`.

## Remote validation sequence

Apply the remote schema:

```bash
npm run d1:migrate:remote
```

Deploy the worker:

```bash
npx wrangler deploy
```

Run the narrow remote smoke:

```bash
curl https://<deployed-worker-host>/healthz
```

Expected response shape:

```json
{
  "ok": true,
  "service": "cloudtable-platform",
  "queues": [
    "event-fanout",
    "workflow-dispatch",
    "workflow-step",
    "projection-maintenance",
    "dead-letter-reprocessor"
  ]
}
```

## Notes

- `wrangler deploy --dry-run` is the preferred non-destructive bundle proof before touching remote resources.
- Cron trigger validation is deploy-time: if the worker deploys successfully with the configured `triggers.crons`, the cron shape is accepted by Wrangler for the target account.
- Durable Object migration health is coupled to deploy because Wrangler applies the configured migration tags during publish.
