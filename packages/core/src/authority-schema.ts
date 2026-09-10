import type { Store } from './store.js';

export const AUTHORITY_SCHEMA_VERSION = 1;

export function migrateAuthority(store: Store): void {
  store.migrate(AUTHORITY_SCHEMA_VERSION, `
    CREATE TABLE authority_spaces (
      space_id TEXT PRIMARY KEY,
      authority_key TEXT NOT NULL,
      owner_member_id TEXT,
      local_authority_member_id TEXT NOT NULL,
      local_alias TEXT NOT NULL,
      is_owner INTEGER NOT NULL CHECK(is_owner IN (0,1)),
      tombstoned INTEGER NOT NULL DEFAULT 0 CHECK(tombstoned IN (0,1)),
      policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
      policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0),
      corpus_revision INTEGER NOT NULL CHECK(corpus_revision >= 0),
      index_generation INTEGER NOT NULL CHECK(index_generation >= 0),
      sync_state TEXT NOT NULL CHECK(sync_state IN ('UNPAIRED','SYNCING','CURRENT','OFFLINE_VALID','EXPIRED','DENIED','STALE')),
      last_sync_ms INTEGER,
      wall_deadline_ms INTEGER,
      monotonic_deadline_ms INTEGER,
      cache_policy_revision INTEGER,
      cache_publication_seq INTEGER,
      cache_projection_digest TEXT,
      cache_response_digest TEXT,
      cache_request_id TEXT,
      cache_stale INTEGER NOT NULL DEFAULT 1 CHECK(cache_stale IN (0,1)),
      next_refresh_wall_ms INTEGER,
      sync_backoff_ms INTEGER NOT NULL DEFAULT 1000 CHECK(sync_backoff_ms BETWEEN 1000 AND 60000),
      UNIQUE(authority_key, local_alias)
    ) STRICT;
    CREATE TABLE authority_members (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      member_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      capabilities TEXT NOT NULL,
      valid_until_ms INTEGER,
      PRIMARY KEY(space_id, member_id)
    ) STRICT;
    CREATE TABLE authority_bindings (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      member_id TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      space_alias TEXT NOT NULL,
      denial_only INTEGER NOT NULL DEFAULT 0 CHECK(denial_only IN (0,1)),
      PRIMARY KEY(space_id, peer_key),
      UNIQUE(peer_key, space_alias)
    ) STRICT;
    CREATE TABLE authority_relationships (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      member_a TEXT NOT NULL,
      member_b TEXT NOT NULL,
      allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
      valid_until_ms INTEGER,
      CHECK(member_a < member_b),
      PRIMARY KEY(space_id, member_a, member_b)
    ) STRICT;
    CREATE TABLE local_policy (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      member_id TEXT NOT NULL,
      admitted INTEGER NOT NULL CHECK(admitted IN (0,1)),
      actions TEXT NOT NULL,
      valid_until_ms INTEGER,
      PRIMARY KEY(space_id, member_id)
    ) STRICT;
    CREATE TABLE document_acl (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      document_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      action TEXT NOT NULL,
      valid_until_ms INTEGER,
      PRIMARY KEY(space_id, document_id, member_id, action)
    ) STRICT;
    CREATE TABLE cached_members (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      member_id TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      PRIMARY KEY(space_id, member_id)
    ) STRICT;
    CREATE TABLE cached_member_keys (
      space_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      PRIMARY KEY(space_id, peer_key),
      FOREIGN KEY(space_id, member_id) REFERENCES cached_members(space_id, member_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE local_peer_aliases (
      space_id TEXT NOT NULL REFERENCES authority_spaces(space_id),
      peer_key TEXT NOT NULL,
      space_alias TEXT NOT NULL,
      PRIMARY KEY(space_id, peer_key),
      UNIQUE(peer_key, space_alias)
    ) STRICT;
    CREATE TABLE publication_counters (
      space_id TEXT NOT NULL,
      authority_key TEXT NOT NULL,
      recipient_key TEXT NOT NULL,
      publication_seq INTEGER NOT NULL CHECK(publication_seq >= 0),
      last_issued_ms INTEGER,
      PRIMARY KEY(space_id, authority_key, recipient_key)
    ) STRICT;
    CREATE TABLE issued_space_state (
      peer_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      policy_revision INTEGER NOT NULL,
      projection_digest TEXT NOT NULL,
      issued_wall_ms INTEGER NOT NULL,
      valid_for_ms INTEGER NOT NULL,
      response_bytes BLOB NOT NULL,
      response_digest TEXT NOT NULL,
      retain_until_ms INTEGER NOT NULL,
      PRIMARY KEY(peer_key, request_id)
    ) STRICT;
    CREATE TABLE pending_space_sync (
      space_id TEXT PRIMARY KEY REFERENCES authority_spaces(space_id),
      authority_key TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      request_bytes BLOB NOT NULL,
      original_wall_ms INTEGER NOT NULL,
      original_monotonic_ms INTEGER NOT NULL,
      next_attempt_monotonic_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0)
    ) STRICT;
    CREATE TABLE authority_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      wall_highwater_ms INTEGER NOT NULL
    ) STRICT;
    INSERT INTO authority_meta(singleton, wall_highwater_ms) VALUES(1, 0);
  `);
}
