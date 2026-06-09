# Cell Set Invalid Number Value

Proves hardened non-select field value validation rejects malformed `number.decimal`
writes through the normal `cell.set` command path before event emission, receipts, or
projection mutation.
