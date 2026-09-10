import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { resolve } from 'node:path';
import { KuroError } from '@kuro/contracts';
import type { CommittedEvent } from '@kuro/contracts';

export type SqlValue = SQLInputValue;
export type FaultInjector = (point: string) => void;
const opened = new Set<string>();

/** Private single connection/writer. No handles cross the AppPort or adapter boundary. */
export class Store {
  readonly #db: DatabaseSync;
  readonly #path: string;
  #depth = 0;
  #events: CommittedEvent[] = [];
  #listeners = new Set<(event: CommittedEvent) => void>();
  #closed = false;
  constructor(path: string, private readonly fault?: FaultInjector) {
    this.#path = path === ':memory:' ? `:memory:${Math.random()}` : resolve(path);
    if (opened.has(this.#path)) throw new KuroError('STORAGE_FAILURE');
    this.#db = new DatabaseSync(path, { timeout: 1000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    opened.add(this.#path);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY) STRICT');
  }
  migrate(version: number, sql: string): void {
    if (this.get('SELECT version FROM migrations WHERE version=?', version)) return;
    this.transaction(() => { this.#db.exec(sql); this.run('INSERT INTO migrations VALUES (?)', version); });
  }
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.#db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    if (this.#depth) return fn();
    this.#db.exec('BEGIN IMMEDIATE'); this.#depth++;
    let result: T;
    try {
      result = fn();
      if (result && typeof result === 'object' && 'then' in result) throw new Error('Async transaction forbidden');
      this.checkpoint('before_commit');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK'); this.#events = []; throw error;
    } finally { this.#depth--; }
    const events = this.#events.splice(0);
    for (const event of events) for (const listener of this.#listeners) {
      try { listener(event); } catch { /* Observers cannot roll back committed state. */ }
    }
    return result;
  }
  emit(event: CommittedEvent): void {
    if (!this.#depth) throw new Error('Events require a writer transaction');
    this.#events.push(event);
  }
  subscribe(listener: (event: CommittedEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  checkpoint(point: string): void { this.fault?.(point); }
  close(): void {
    if (this.#closed) return;
    this.#db.close(); this.#closed = true; opened.delete(this.#path); this.#listeners.clear();
  }
}
