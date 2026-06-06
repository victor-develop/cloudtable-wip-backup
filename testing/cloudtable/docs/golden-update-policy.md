# CloudTable Golden Update Policy

Deterministic fixtures are review artifacts, not disposable snapshots.

Rules:

- Never auto-accept semantic diffs in CI.
- Every fixture change must explain whether the semantic contract changed or the previous fixture was wrong.
- Promotion from incident to regression must happen in the same change or in an explicitly linked blocker follow-up.
- When changing a canonical fixture, update `notes.md` with the behavioral risk being covered.
- Nightly Cloudflare smoke expectations may only verify adapter trust. Product semantics must stay in the deterministic suites.

Expected review flow:

1. Run the narrow suite that owns the changed behavior.
2. Inspect the canonical diff for events, replay state, permissions, workflows, or views.
3. Update fixture files intentionally and keep unrelated golden churn out of the change.
4. Run `npm run test:semantic` before landing the update.
