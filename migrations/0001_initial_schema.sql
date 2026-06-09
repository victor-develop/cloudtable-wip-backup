PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT
);

CREATE TABLE IF NOT EXISTS workspace_principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  external_principal_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, principal_type, external_principal_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, slug),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_epoch INTEGER NOT NULL DEFAULT 0,
  current_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, app_id, slug),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (app_id) REFERENCES apps (id)
);

CREATE TABLE IF NOT EXISTS table_schema_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_principal_id TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, table_id, schema_version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (table_id) REFERENCES tables (id)
);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  field_order INTEGER,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  field_type_version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, table_id, field_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (table_id) REFERENCES tables (id)
);

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  view_key TEXT NOT NULL,
  name TEXT NOT NULL,
  current_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, table_id, view_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (table_id) REFERENCES tables (id)
);

CREATE TABLE IF NOT EXISTS view_schema_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_principal_id TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, view_id, schema_version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (view_id) REFERENCES views (id)
);

CREATE TABLE IF NOT EXISTS permission_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_principal_id TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, policy_key, revision),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS permission_policy_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_principal_id TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, binding_key, revision),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS permission_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  scope_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, principal_id, policy_revision, scope_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, workflow_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  published_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, workflow_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workflow_id) REFERENCES workflows (id)
);

CREATE TABLE IF NOT EXISTS workflow_operator_refs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  operator_slot_key TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  UNIQUE (workspace_id, workflow_version_id, operator_slot_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions (id)
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  last_event_id TEXT,
  UNIQUE (workspace_id, table_id, record_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (table_id) REFERENCES tables (id)
);

CREATE TABLE IF NOT EXISTS cell_current (
  record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_version INTEGER NOT NULL DEFAULT 1,
  value_json TEXT NOT NULL,
  text_value TEXT,
  number_value REAL,
  bool_value INTEGER,
  datetime_value TEXT,
  reference_value TEXT,
  display_value TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  value_hash TEXT NOT NULL,
  cell_revision INTEGER NOT NULL DEFAULT 0,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY (record_id, field_id),
  FOREIGN KEY (record_id) REFERENCES records (id),
  FOREIGN KEY (field_id) REFERENCES fields (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (table_id) REFERENCES tables (id)
);

CREATE TABLE IF NOT EXISTS record_projection (
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  search_document TEXT NOT NULL DEFAULT '',
  projection_version INTEGER NOT NULL DEFAULT 0,
  last_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, table_id, record_id)
);

CREATE TABLE IF NOT EXISTS field_index_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  index_key TEXT NOT NULL,
  index_mode TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, table_id, index_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (table_id) REFERENCES tables (id),
  FOREIGN KEY (field_id) REFERENCES fields (id)
);

CREATE TABLE IF NOT EXISTS field_index_entries (
  workspace_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  index_value_text TEXT,
  index_value_number REAL,
  index_value_datetime TEXT,
  index_value_bool INTEGER,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, table_id, field_id, record_id)
);

CREATE TABLE IF NOT EXISTS view_row_order_overrides (
  workspace_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  order_rank TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, view_id, record_id)
);

CREATE TABLE IF NOT EXISTS event_ledger (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  table_id TEXT,
  event_type TEXT NOT NULL,
  command_id TEXT NOT NULL,
  aggregate_id TEXT,
  workspace_sequence INTEGER NOT NULL,
  table_sequence INTEGER,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, workspace_sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_ledger_table_sequence
  ON event_ledger (workspace_id, table_id, table_sequence)
  WHERE table_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_receipts (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_event_id TEXT,
  UNIQUE (scope_key, idempotency_key)
);

CREATE TABLE IF NOT EXISTS queue_outbox (
  outbox_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  delivered_at TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (event_id) REFERENCES event_ledger (event_id)
);

CREATE TABLE IF NOT EXISTS workspace_sequence_leases (
  lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  lease_owner_key TEXT NOT NULL,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  next_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  leased_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT,
  UNIQUE (workspace_id, lease_owner_key, start_sequence),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  trigger_event_id TEXT NOT NULL,
  manual_invocation_id TEXT,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  dead_lettered_at TEXT,
  state_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workflow_id) REFERENCES workflows (id),
  FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_manual_invocation
  ON workflow_runs (workspace_id, workflow_id, manual_invocation_id)
  WHERE manual_invocation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  output_json TEXT,
  audit_json TEXT NOT NULL,
  last_error_code TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workflow_run_id, step_key),
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS workflow_run_idempotency (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, idempotency_key),
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id)
);

CREATE TABLE IF NOT EXISTS workflow_dead_letters (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  failure_code TEXT NOT NULL,
  failure_message TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);
