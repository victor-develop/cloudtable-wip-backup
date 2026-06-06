# CloudTable Fixture Authoring

Command transcript fixtures in v0 live under `testing/cloudtable/fixtures/commands/<scenario>`.
As semantic suites expand, keep the same one-scenario-per-directory layout under:

- `testing/cloudtable/fixtures/replays`
- `testing/cloudtable/fixtures/permissions`
- `testing/cloudtable/fixtures/workflows`
- `testing/cloudtable/fixtures/views`

Required files:

- `meta.json`
- `command.json`
- `expected-events.json`
- `expected-projections.json`
- `expected-side-effects.json`
- `expected-result.json`
- `expected-permission.json`
- `notes.md`

Optional files:

- `seed-state.json` for seeded idempotency receipts or permission overrides

Rules:

- Use text-first fixtures under `testing/cloudtable/fixtures`.
- Keep JSON keys sorted and files newline-terminated.
- Put append-order event streams in JSONL files when order matters across multiple records.
- Never rely on runtime-generated ids in assertions.
- Store replay expectations in `expected-projections.json`, not inline in test code.
- Update golden files intentionally and follow `testing/cloudtable/docs/golden-update-policy.md`.

Suggested verification commands:

- `npm run test:command-golden`
- `npm run test:replay`
- `npm run test:permissions`
- `npm run test:workflows`
- `npm run test:views`
