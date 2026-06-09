# Cell Set Invalid Datetime Value

Proves hardened `date.datetime` value validation rejects malformed writes through
the normal `cell.set` command path before event emission, receipts, or projection
mutation.
