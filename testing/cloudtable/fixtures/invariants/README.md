# CloudTable Invariant Fixtures

This lane is reserved for bounded deterministic-property scenarios that need a
reviewable corpus artifact in addition to code-driven assertions.

Current `test:invariants` coverage is code-first in
`testing/cloudtable/suites/invariants/determinism.spec.ts`. Promote minimized
scenario fixtures into this directory when an invariant needs a reusable input
set or incident-driven golden artifact.
