# Cell Set Invalid Date Value

Proves hardened `date.date` value validation rejects malformed writes through the
normal `cell.set` command path before event emission, receipts, or projection
mutation.
