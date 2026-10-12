import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * SQLite in WAL mode: several processes (three services, the bus, the platform) each open their own
 * file; the bus file is shared. busy_timeout turns lock contention into a short wait, not an error.
 * See ADR-0017 for why this replaces Postgres at this scope.
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // busy_timeout MUST come first: switching a fresh file to WAL takes a lock, and several services
  // open the shared bus file at the same instant on first boot.
  db.exec('PRAGMA busy_timeout=10000;');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
  return db;
}

/** Run `fn` atomically. Re-entrant: an inner call joins the outer transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Convert booleans/undefined (which node:sqlite rejects) into bindable values. */
export function bind(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as SqlValue;
}

export function dataDir(): string {
  return process.env.CAUSORA_DATA_DIR ?? 'data';
}
