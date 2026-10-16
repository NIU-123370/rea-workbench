// First-release logical schema from DESIGN §5. Migrations are additive and
// reentrant; each one is recorded by name plus the checksum of its own SQL, and
// a recorded id this binary does not know is refused, so an older build cannot
// quietly run against a newer schema (A12, D23).

export type Migration = {
  readonly id: string;
  readonly sql: string;
  // A table rebuild cannot run while foreign keys are enforced: SQLite treats
  // `DROP TABLE` on a parent as an implicit delete, and every RESTRICT child row then
  // stops it. `deferForeignKeys` tells the runner to switch enforcement off around the
  // transaction rather than inside it (a pragma is ignored inside a transaction), and the
  // runner then verifies the whole schema with `PRAGMA foreign_key_check` before commit,
  // so a rebuild still cannot leave a half-upgraded database (D23).
  readonly deferForeignKeys?: boolean;
};

export const SCHEMA_VERSION = 1;

// SQLite GLOB treats `*` as "any sequence", not as a repetition of the previous
// class, so `x GLOB '[0-9a-f]*'` alone only checks the first character. The
// negated form rejects everything outside the hex alphabet.
function digestCheck(column: string, nullable: boolean): string {
  const shape = `length(${column}) = 64 AND ${column} GLOB '[0-9a-f]*' AND ${column} NOT GLOB '*[^0-9a-f]*'`;
  return nullable ? `${column} IS NULL OR (${shape})` : `(${column} IS NOT NULL AND ${shape})`;
}

function digestColumn(name: string, nullable = true): string {
  return `${name} TEXT CHECK (${digestCheck(name, nullable)})`;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-core",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  sql_sha256 TEXT NOT NULL CHECK (${digestCheck("sql_sha256", false)}),
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
  ${digestColumn("sha256")},
  digest_reason TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (sha256 IS NOT NULL OR digest_reason IS NOT NULL),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('url','har','asar')),
  original_locator TEXT,
  ${digestColumn("source_sha256")},
  source_artifact_id TEXT,
  ${digestColumn("snapshot_digest")},
  identity_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (snapshot_digest IS NOT NULL OR identity_reason IS NOT NULL),
  FOREIGN KEY (project_id, source_artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('capture','inspect','build','verify')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending','complete','failed')),
  input_json TEXT NOT NULL,
  result_ref TEXT,
  error_json TEXT,
  idempotency_key TEXT NOT NULL,
  ${digestColumn("request_digest", false)},
  deadline_at TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS resource_leases (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_identity_json TEXT NOT NULL,
  ownership_proof_json TEXT NOT NULL,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending','complete','failed')),
  last_error_json TEXT,
  retry_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
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
  artifact_id TEXT NOT NULL,
  provider_json TEXT NOT NULL,
  operation TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('observed','derived','inferred')),
  authority TEXT NOT NULL CHECK (authority IN ('shipped-artifact','controlled-replay','historical-reference','external-service','analyst-inference')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  CHECK (id GLOB 'ev_*' AND length(id) = 67 AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, job_id) REFERENCES jobs(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT
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
  UNIQUE (target_id, claim_key, revision),
  UNIQUE (project_id, id)
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
  FOREIGN KEY (project_id, claim_id) REFERENCES claims(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT
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
  ${digestColumn("snapshot_digest", false)},
  payload_artifact_id TEXT NOT NULL,
  ${digestColumn("digest", false)},
  replaces_id TEXT,
  case_key TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','holdout')),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('usable','blocked')),
  reasons_json TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','approved','rejected')),
  review_record_json TEXT,
  CHECK (replaces_id IS NULL OR replaces_id <> id),
  FOREIGN KEY (project_id, evidence_id) REFERENCES evidence_records(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, payload_artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, replaces_id) REFERENCES test_vectors(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS contract_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload_json TEXT NOT NULL,
  ${digestColumn("digest", false)},
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','approved','rejected')),
  review_record_json TEXT,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, contract_key, revision),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS verification_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  ${digestColumn("snapshot_digest", false)},
  graph_revision INTEGER NOT NULL CHECK (graph_revision >= 0),
  inventory_revision INTEGER NOT NULL CHECK (inventory_revision >= 0),
  ${digestColumn("inventory_digest", false)},
  payload_json TEXT NOT NULL,
  ${digestColumn("digest", false)},
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','approved','rejected')),
  review_record_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  graph_revision INTEGER NOT NULL CHECK (graph_revision >= 0),
  ${digestColumn("snapshot_digest", false)},
  verification_plan_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  ${digestColumn("digest", false)},
  source_manifest_artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, verification_plan_id) REFERENCES verification_plans(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, source_manifest_artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, target_id) REFERENCES targets(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  blueprint_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  ${digestColumn("digest", false)},
  generator_json TEXT NOT NULL,
  dependency_manifest_json TEXT NOT NULL,
  FOREIGN KEY (project_id, blueprint_id) REFERENCES blueprints(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, job_id) REFERENCES jobs(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  ${digestColumn("plan_digest", false)},
  ${digestColumn("inventory_digest", false)},
  ${digestColumn("blueprint_digest", false)},
  ${digestColumn("vector_set_digest", false)},
  ${digestColumn("comparator_digest", false)},
  ${digestColumn("runner_image_digest", false)},
  result TEXT NOT NULL CHECK (result IN ('PASS','FAIL','UNKNOWN')),
  currentness TEXT NOT NULL CHECK (currentness IN ('current','stale')),
  summary_json TEXT NOT NULL,
  report_artifact_id TEXT NOT NULL,
  FOREIGN KEY (project_id, candidate_id) REFERENCES candidates(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, plan_id) REFERENCES verification_plans(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, job_id) REFERENCES jobs(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, report_artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT,
  UNIQUE (project_id, id)
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
  verification_id TEXT,
  label TEXT NOT NULL CHECK (label IN ('draft','verified-samples')),
  artifact_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (label <> 'verified-samples' OR verification_id IS NOT NULL),
  FOREIGN KEY (project_id, candidate_id) REFERENCES candidates(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, verification_id) REFERENCES verifications(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts(project_id, id) ON DELETE RESTRICT
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
  {
    id: "0005-artifact-export-class",
    deferForeignKeys: true,
    // Delivery gets its own artifact class (DESIGN §5 exports row, §8 lines 299-300 /
    // issue #22). A package bundles candidate source with a published report, so it must
    // not be smuggled inside one of the four producer classes whose isolation §5 names as
    // a permission boundary; it needs a partition of its own, which means the class CHECK
    // has to grow. SQLite cannot alter a CHECK, so this is the create-copy-drop-rename
    // sequence — the same columns and constraints, one extra class value.
    sql: `
CREATE TABLE artifacts_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  job_id TEXT,
  class TEXT NOT NULL CHECK (class IN ('inspector','blueprint','candidate','report','export')),
  ${digestColumn("sha256")},
  digest_reason TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (sha256 IS NOT NULL OR digest_reason IS NOT NULL),
  UNIQUE (project_id, id)
);

INSERT INTO artifacts_new (id, project_id, job_id, class, sha256, digest_reason, byte_length, storage_key, media_type, created_at)
  SELECT id, project_id, job_id, class, sha256, digest_reason, byte_length, storage_key, media_type, created_at FROM artifacts;

DROP TABLE artifacts;

ALTER TABLE artifacts_new RENAME TO artifacts;
`,
  },
  {
    id: "0006-jobs-project-created",
    // The left column's job page (§8 line 277) reads a project's jobs newest-first with a
    // keyset cursor, and `idx_jobs_project_state` cannot serve it: the page is not filtered
    // by state, and its cut is on (created_at, id). Additive and index-only, so an
    // interrupted run leaves a table that is still readable by the previous build.
    sql: `
CREATE INDEX IF NOT EXISTS idx_jobs_project_created ON jobs (project_id, created_at DESC, id DESC);
`,
  },
  {
    id: "0007-vectors-target-keyset",
    // The inventory page (§8 line 283) is cut on `(project_id, target_id, id)`, so the index
    // the plan-side snapshot query uses cannot serve it. Additive and index-only: an
    // interrupted run leaves a table the previous build still reads.
    sql: `
CREATE INDEX IF NOT EXISTS idx_vectors_project_target_id ON test_vectors (project_id, target_id, id);
`,
  },
] as const;

export const KNOWN_MIGRATION_IDS: readonly string[] = MIGRATIONS.map((migration) => migration.id);
