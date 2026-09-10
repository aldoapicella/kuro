"""Executable KURO design model. Not an app, QVAC adapter, or security boundary."""
from dataclasses import dataclass, field
from hashlib import sha256
import json
import sqlite3


class Denied(ValueError):
    pass


@dataclass(frozen=True)
class Document:
    space: str
    version: int
    spans: dict[str, str]
    audiences: dict[str, frozenset[str]]


@dataclass(frozen=True)
class Policy:
    members: frozenset[tuple[str, str]]
    verified: frozenset[str]
    grants: frozenset[tuple[str, str, str]]
    documents: dict[str, Document]
    epoch: int = 1
    corpus_revision: int = 1
    expires: int = 1000
    authorities: dict[str, str] = field(default_factory=dict)

    def can(self, person, action, space, now, document=None):
        if not (now < self.expires and person in self.verified
                and (person, space) in self.members
                and (person, space, action) in self.grants):
            return False
        if document is None:
            return True
        doc = self.documents.get(document)
        return bool(doc and doc.space == space
                    and person in doc.audiences.get(action, frozenset()))

    def may_change_content_grants(self, person, space, now, expected_epoch):
        return (self.epoch == expected_epoch and self.authorities.get(space) == person
                and self.can(person, 'manage', space, now))


@dataclass(frozen=True)
class Request:
    request_id: str
    space: str
    recipient: str  # Resolved by trusted transport binding, not by message JSON.
    query_audience: frozenset[str]
    expires: int


@dataclass(frozen=True)
class Draft:
    request: Request
    reviewer: str
    exposure: tuple[tuple[str, int], ...]  # Core records ALL context, not model citations.
    selections: tuple[tuple[str, str], ...]  # Document and span IDs, no generated quotes.
    epoch: int
    corpus_revision: int
    revision: int = 1


def materialize(policy, draft, now):
    r = draft.request
    if now >= r.expires or draft.epoch != policy.epoch or draft.corpus_revision != policy.corpus_revision:
        raise Denied('stale request, policy or corpus')
    if not policy.can(r.recipient, 'search', r.space, now):
        raise Denied('requester not authorized')
    if not {r.recipient, draft.reviewer} <= r.query_audience:
        raise Denied('query audience')
    if not draft.exposure or not draft.selections or len(draft.selections) > 4:
        raise Denied('missing or excessive evidence')
    if len(set(draft.exposure)) != len(draft.exposure) or len(set(draft.selections)) != len(draft.selections):
        raise Denied('duplicate dependency or evidence')
    exposed = set()
    for document, version in draft.exposure:
        doc = policy.documents.get(document)
        if not doc or doc.version != version or document in exposed:
            raise Denied('unknown or ambiguous source version')
        for person, action in ((draft.reviewer, 'read'), (draft.reviewer, 'share'), (r.recipient, 'receive')):
            if not policy.can(person, action, r.space, now, document):
                raise Denied('source permission')
        exposed.add(document)
    evidence = []
    for document, span in draft.selections:
        if document not in exposed:
            raise Denied('evidence outside recorded context')
        doc = policy.documents[document]
        if span not in doc.spans:
            raise Denied('unknown span')
        evidence.append({'source': document, 'version': doc.version,
                         'span': span, 'quote': doc.spans[span]})
    payload = {'v': 1, 'type': 'APPROVED_RESPONSE', 'requestId': r.request_id,
               'space': r.space, 'recipient': r.recipient, 'evidence': evidence}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


class Outbox:
    """Single-writer model. Production must read policies in the SAME transaction."""
    def __init__(self, path=':memory:'):
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS review (id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('REVIEW','APPROVED')));
          CREATE TABLE IF NOT EXISTS approval (id TEXT PRIMARY KEY REFERENCES review(id),
            payload BLOB NOT NULL, digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY REFERENCES approval(id),
            state TEXT NOT NULL CHECK(state IN ('READY','DISPATCHING','ACKED')));
        ''')

    def stage(self, request_id, revision=1):
        with self.db:
            self.db.execute('INSERT INTO review VALUES (?, ?, ?)', (request_id, revision, 'REVIEW'))

    def approve(self, policy, draft, now, expected_revision, fail_after_approval=False):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT revision,state FROM review WHERE id=?', (draft.request.request_id,)).fetchone()
            if row != (expected_revision, 'REVIEW') or draft.revision != expected_revision:
                raise Denied('review conflict')
            payload = materialize(policy, draft, now)
            digest = sha256(payload).hexdigest()
            self.db.execute('INSERT INTO approval VALUES (?,?,?)', (draft.request.request_id, payload, digest))
            if fail_after_approval:
                raise RuntimeError('injected failure before outbox')
            self.db.execute('INSERT INTO outbox VALUES (?,?)', (draft.request.request_id, 'READY'))
            self.db.execute("UPDATE review SET state='APPROVED' WHERE id=?", (draft.request.request_id,))
        return payload

    def dispatch(self, policy, draft, now):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT payload,digest FROM approval JOIN outbox USING(id) WHERE id=? AND state!=?',
                                  (draft.request.request_id, 'ACKED')).fetchone()
            if row is None:
                raise Denied('no pending approved delivery')
            payload, digest = row
            # Reconstruction is ONLY a reference-model consistency check. Transport uses stored bytes.
            if sha256(payload).hexdigest() != digest or payload != materialize(policy, draft, now):
                raise Denied('approved payload changed')
            self.db.execute("UPDATE outbox SET state='DISPATCHING' WHERE id=?", (draft.request.request_id,))
        return payload

    def close(self):
        self.db.close()


class Inbox:
    """Checks correlation and deduplication only; does not validate source truth."""
    def __init__(self):
        self.values = {}

    def receive(self, authenticated_peer, expected_peer, space, expected_space, response_id, payload):
        if authenticated_peer != expected_peer or space != expected_space:
            raise Denied('unexpected peer or space')
        key = (authenticated_peer, response_id)
        digest = sha256(payload).hexdigest()
        if key in self.values:
            if self.values[key] != digest:
                raise Denied('same ID with different payload')
            return 'duplicate'
        self.values[key] = digest
        return 'stored'
