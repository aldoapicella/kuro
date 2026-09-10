// Run with the exact host executable. This is not an Electron packaging test.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kuro-host-probe-'));
try {
  const path = join(directory, 'probe.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id)); CREATE VIRTUAL TABLE passage USING fts5(text)');
  let foreignKeys = false;
  try { db.prepare('INSERT INTO child VALUES (?)').run(99); } catch { foreignKeys = true; }
  db.prepare('INSERT INTO passage VALUES (?)').run('KURO evidence');
  const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
  db.close();
  const reopened = new DatabaseSync(path);
  const fts5 = reopened.prepare("SELECT count(*) AS n FROM passage WHERE passage MATCH 'evidence'").get().n === 1;
  reopened.close();
  if (!foreignKeys || !fts5) throw new Error('SQLite capability probe failed');
  console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch, sqlite, foreignKeys, fts5, reopen: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
