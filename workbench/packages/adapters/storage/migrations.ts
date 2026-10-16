// First-release logical schema from DESIGN §5. Migrations are additive and
// reentrant; each one is recorded by name plus the checksum of its own SQL so
// an edited historical step fails loudly instead of silently half-upgrading.

export type Migration = { readonly id: string; readonly sql: string };

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-core",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  sql_sha256 TEXT NOT NULL CHECK (sql_sha256 GLOB '[0-9a-f]*' AND length(sql_sha256) = 64),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  graph_revision INTEGER NOT NULL DEFAULT 0 CHECK (graph_revision >= 0),
  inventory_revision INTEGER NOT NULL DEFAULT 0 CHECK (inventory_revision >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  job_id TEXT,
  class TEXT NOT NULL CHECK (class IN ('inspector','blueprint','candidate','report')),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 GLOB '[0-9a-f]*')),
  digest_reason TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (sha256 IS NOT NULL OR digest_reason IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('url','har','asar')),
  original_locator TEXT,
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR (length(source_sha256) = 64 AND source_sha256 GLOB '[0-9a-f]*')),
  source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  snapshot_digest TEXT CHECK (snapshot_digest IS NULL OR (length(snapshot_digest) = 64 AND snapshot_digest GLOB '[0-9a-f]*')),
  identity_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (snapshot_digest IS NOT NULL OR identity_reason IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT REFERENCES targets(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('capture','inspect','build','verify')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending','complete','failed')),
  input_json TEXT NOT NULL,
  result_ref TEXT,
  error_json TEXT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest GLOB '[0-9a-f]*'),
  deadline_at TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS resource_leases (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  resource_identity_json TEXT NOT NULL,
  ownership_proof_json TEXT NOT NULL,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending','complete','failed')),
  last_error_json TEXT,
  retry_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_state ON jobs (project_id, state);
`,
  },
  {
    id: "0002-evidence-graph",
    sql: `
CREATE TABLE IF NOT EXISTS evidence_records (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  provider_json TEXT NOT NULL,
  operation TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('observed','derived','inferred')),
  authority TEXT NOT NULL CHECK (authority IN ('shipped-artifact','controlled-replay','historical-reference','external-service','analyst-inference')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, job_id) REFERENCES jobs(project_id, id) ON DELETE RESTRICT,
  CHECK (id GLOB 'ev_*')
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  claim_key TEXT NOT NULL,
  assertion TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('observed','derived','inferred','unknown')),
  source_state TEXT,
  coverage_json TEXT NOT NULL,
  validity TEXT NOT NULL CHECK (validity IN ('current','stale','contradicted')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  unknown_reasons_json TEXT NOT NULL,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  UNIQUE (target_id, claim_key, revision)
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  project_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  location_json TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('support','contradict')),
  PRIMARY KEY (project_id, claim_id, evidence_id, role),
  FOREIGN KEY (project_id, claim_id) REFERENCES claims(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, evidence_id) REFERENCES evidence_records(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  relation TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  FOREIGN KEY (project_id, claim_id) REFERENCES claims(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_claims_target_entity ON claims (target_id, entity_key);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_id ON claim_evidence (evidence_id);
`,
  },
  {
    id: "0003-delivery",
    sql: `
CREATE TABLE IF NOT EXISTS test_vectors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  source_locator_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64 AND snapshot_digest GLOB '[0-9a-f]*'),
  payload_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest GLOB '[0-9a-f]*'),
  replaces_id TEXT REFERENCES test_vectors(id) ON DELETE RESTRICT,
  case_key TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','holdout')),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('usable','blocked')),
  reasons_json TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','approved','rejected')),
  review_record_json TEXT,
  FOREIGN KEY (project_id, evidence_id) REFERENCES evidence_records(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  CHECK (replaces_id IS NULL OR replaces_id <> id)
);

CREATE TABLE IF NOT EXISTS contract_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest GLOB '[0-9a-f]*'),
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','approved','rejected')),
  review_record_json TEXT,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, contract_key, revision)
);

CREATE TABLE IF NOT EXISTS verification_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64 AND snapshot_digest GLOB '[0-9a-f]*'),
  graph_revision INTEGER NOT NULL CHECK (graph_revision >= 0),
  inventory_revision INTEGER NOT NULL CHECK (inventory_revision >= 0),
  inventory_digest TEXT NOT NULL CHECK (length(inventory_digest) = 64 AND inventory_digest GLOB '[0-9a-f]*'),
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest GLOB '[0-9a-f]*'),
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','approved','rejected')),
  review_record_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  graph_revision INTEGER NOT NULL CHECK (graph_revision >= 0),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64 AND snapshot_digest GLOB '[0-9a-f]*'),
  verification_plan_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest GLOB '[0-9a-f]*'),
  source_manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, verification_plan_id) REFERENCES verification_plans(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  blueprint_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest GLOB '[0-9a-f]*'),
  generator_json TEXT NOT NULL,
  dependency_manifest_json TEXT NOT NULL,
  FOREIGN KEY (project_id, blueprint_id) REFERENCES blueprints(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, job_id) REFERENCES jobs(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest GLOB '[0-9a-f]*'),
  inventory_digest TEXT NOT NULL CHECK (length(inventory_digest) = 64 AND inventory_digest GLOB '[0-9a-f]*'),
  blueprint_digest TEXT NOT NULL CHECK (length(blueprint_digest) = 64 AND blueprint_digest GLOB '[0-9a-f]*'),
  vector_set_digest TEXT NOT NULL CHECK (length(vector_set_digest) = 64 AND vector_set_digest GLOB '[0-9a-f]*'),
  comparator_digest TEXT NOT NULL CHECK (length(comparator_digest) = 64 AND comparator_digest GLOB '[0-9a-f]*'),
  runner_image_digest TEXT NOT NULL CHECK (length(runner_image_digest) = 64 AND runner_image_digest GLOB '[0-9a-f]*'),
  result TEXT NOT NULL CHECK (result IN ('PASS','FAIL','UNKNOWN')),
  currentness TEXT NOT NULL CHECK (currentness IN ('current','stale')),
  summary_json TEXT NOT NULL,
  report_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, candidate_id) REFERENCES candidates(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, plan_id) REFERENCES verification_plans(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_vectors_project_target ON test_vectors (project_id, target_id);
`,
  },
  {
    id: "0004-events-audit",
    sql: `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL,
  verification_id TEXT REFERENCES verifications(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (label IN ('draft','verified-samples')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, candidate_id) REFERENCES candidates(project_id, id) ON DELETE RESTRICT,
  CHECK (label <> 'verified-samples' OR verification_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS audit_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason_code TEXT NOT NULL,
  safe_metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events (project_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_project_seq ON audit_entries (project_id, seq);
`,
  },
] as const;
