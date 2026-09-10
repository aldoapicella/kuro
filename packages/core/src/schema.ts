export const WORKFLOW_SCHEMA = `
CREATE TABLE core_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE documents(
 space_id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL,
 revision INTEGER NOT NULL, ingestion_state TEXT NOT NULL,
 PRIMARY KEY(space_id,document_id)
) STRICT;
CREATE TABLE versions(
 space_id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL,
 bytes BLOB NOT NULL, source_digest TEXT NOT NULL, local_path TEXT,
 PRIMARY KEY(space_id,document_id,version_id),
 FOREIGN KEY(space_id,document_id) REFERENCES documents(space_id,document_id)
) STRICT;
CREATE TABLE spans(
 space_id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL, span_id TEXT NOT NULL,
 start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, text TEXT NOT NULL, fingerprint TEXT NOT NULL,
 PRIMARY KEY(space_id,document_id,version_id,span_id),
 FOREIGN KEY(space_id,document_id,version_id) REFERENCES versions(space_id,document_id,version_id)
) STRICT;
CREATE VIRTUAL TABLE literal_index USING fts5(space_id UNINDEXED, document_id UNINDEXED, version_id UNINDEXED, span_id UNINDEXED, text);
CREATE TABLE index_generations(
 space_id TEXT NOT NULL, generation INTEGER NOT NULL, profile_json TEXT NOT NULL, corpus_revision INTEGER NOT NULL,
 state TEXT NOT NULL, PRIMARY KEY(space_id,generation)
) STRICT;
CREATE TABLE embeddings(
 space_id TEXT NOT NULL, generation INTEGER NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL,
 span_id TEXT NOT NULL, profile_key TEXT NOT NULL, fingerprint TEXT NOT NULL, vector BLOB NOT NULL,
 PRIMARY KEY(space_id,generation,document_id,version_id,span_id),
 FOREIGN KEY(space_id,generation) REFERENCES index_generations(space_id,generation),
 FOREIGN KEY(space_id,document_id,version_id,span_id) REFERENCES spans(space_id,document_id,version_id,span_id)
) STRICT;
CREATE TABLE requests(
 request_id TEXT PRIMARY KEY, direction TEXT NOT NULL, space_id TEXT NOT NULL, peer_key TEXT NOT NULL,
 member_id TEXT NOT NULL, space_alias TEXT NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL,
 query TEXT NOT NULL, state TEXT NOT NULL, admitted_wall INTEGER NOT NULL, expires_wall INTEGER NOT NULL,
 expires_mono INTEGER NOT NULL, policy_epoch INTEGER NOT NULL, corpus_revision INTEGER NOT NULL,
 index_generation INTEGER NOT NULL, job_id TEXT, next_attempt INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, response_id TEXT, UNIQUE(peer_key,request_id)
) STRICT;
CREATE TABLE jobs(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL UNIQUE, space_id TEXT NOT NULL,
 identity_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
 policy_epoch INTEGER NOT NULL, corpus_revision INTEGER NOT NULL, index_generation INTEGER NOT NULL,
 deadline_wall INTEGER, deadline_mono INTEGER, computation_ms INTEGER NOT NULL DEFAULT 0, error_code TEXT
) STRICT;
CREATE TABLE reviews(
 draft_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(request_id),
 space_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, view_json TEXT NOT NULL
) STRICT;
CREATE TABLE approvals(
 response_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES reviews(draft_id),
 request_id TEXT NOT NULL REFERENCES requests(request_id), space_id TEXT NOT NULL, peer_key TEXT NOT NULL,
 reviewer_id TEXT NOT NULL, view_digest TEXT NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL,
 dependencies TEXT NOT NULL, policy_epoch INTEGER NOT NULL, corpus_revision INTEGER NOT NULL,
 index_generation INTEGER NOT NULL, expires_wall INTEGER NOT NULL, expires_mono INTEGER NOT NULL
) STRICT;
CREATE TABLE outbox(
 response_id TEXT PRIMARY KEY REFERENCES approvals(response_id), state TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE inbox(
 peer_key TEXT NOT NULL, response_id TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(request_id),
 space_id TEXT NOT NULL, space_alias TEXT NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL,
 first_receipt_wall INTEGER NOT NULL, expires_wall INTEGER NOT NULL, expires_mono INTEGER NOT NULL,
 received_process TEXT NOT NULL, PRIMARY KEY(peer_key,response_id), UNIQUE(request_id)
) STRICT;
CREATE TABLE received_spans(
 peer_key TEXT NOT NULL, response_id TEXT NOT NULL, span_ordinal INTEGER NOT NULL, passage_json TEXT NOT NULL,
 PRIMARY KEY(peer_key,response_id,span_ordinal), FOREIGN KEY(peer_key,response_id) REFERENCES inbox(peer_key,response_id)
) STRICT;
CREATE TABLE summaries(
 summary_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, response_id TEXT NOT NULL,
 space_id TEXT NOT NULL, state TEXT NOT NULL, preparation_json TEXT, result_json TEXT,
 policy_epoch INTEGER NOT NULL, expires_wall INTEGER NOT NULL, error_code TEXT
) STRICT;
CREATE INDEX jobs_waiting ON jobs(state,identity_id,sequence);
CREATE INDEX requests_identity ON requests(member_id,state);
CREATE INDEX request_retry ON requests(direction,state,next_attempt);
CREATE INDEX span_versions ON spans(space_id,document_id,version_id);
`;
