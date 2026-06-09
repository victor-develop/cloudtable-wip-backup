# Cell Set Invalid Boolean Value

Proves hardened `boolean.checkbox` value validation rejects malformed writes through
the normal `cell.set` command path before event emission, receipts, or projection
mutation.
