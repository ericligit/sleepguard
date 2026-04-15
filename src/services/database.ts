/**
 * Local SQLite database via @op-engineering/op-sqlite.
 *
 * Schema:
 *   sessions   — one row per overnight recording session
 *   events     — timestamped audio events detected by the ML model (Phase 2)
 *
 * All timestamps are stored as Unix milliseconds (INTEGER).
 * Sensitive fields (notes) are kept in SQLite; the audio files themselves
 * are encrypted at the filesystem level via Android Keystore (Phase 1 stretch).
 */

import {open} from '@op-engineering/op-sqlite';
import type {DB} from '@op-engineering/op-sqlite';
import type {SleepSession, AudioEvent} from '../types';

const DB_NAME = 'sleepguard.db';

let db: DB | null = null;

export async function initDatabase(): Promise<void> {
  db = open({name: DB_NAME});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT    PRIMARY KEY,
      startedAt       INTEGER NOT NULL,
      endedAt         INTEGER,
      durationSeconds REAL    DEFAULT 0,
      filePath        TEXT    NOT NULL,
      fileSizeBytes   INTEGER DEFAULT 0,
      ahi             REAL,
      severity        TEXT,
      apneaCount      INTEGER DEFAULT 0,
      hypopneaCount   INTEGER DEFAULT 0,
      longestApneaSec REAL    DEFAULT 0,
      spo2Min         REAL,
      spo2Avg         REAL,
      notes           TEXT    DEFAULT ''
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id             TEXT    PRIMARY KEY,
      sessionId      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type           TEXT    NOT NULL,
      startOffsetSec REAL    NOT NULL,
      durationSec    REAL    NOT NULL,
      confidence     REAL    NOT NULL DEFAULT 1.0
    );
  `);

  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_events_session ON events (sessionId);`,
  );
}

function getDb(): DB {
  if (!db) throw new Error('Database not initialised — call initDatabase() first');
  return db;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function insertSession(session: SleepSession): Promise<void> {
  await getDb().execute(
    `INSERT INTO sessions
       (id, startedAt, endedAt, durationSeconds, filePath, fileSizeBytes,
        ahi, severity, apneaCount, hypopneaCount, longestApneaSec,
        spo2Min, spo2Avg, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      session.id,
      session.startedAt,
      session.endedAt ?? null,
      session.durationSeconds,
      session.filePath,
      session.fileSizeBytes,
      session.ahi ?? null,
      session.severity ?? null,
      session.apneaCount,
      session.hypopneaCount,
      session.longestApneaSec,
      session.spo2Min ?? null,
      session.spo2Avg ?? null,
      session.notes,
    ],
  );
}

export async function updateSession(
  id: string,
  fields: Partial<Omit<SleepSession, 'id'>>,
): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return;
  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => (fields[k] ?? null) as string | number | null);
  await getDb().execute(
    `UPDATE sessions SET ${setClauses} WHERE id = ?`,
    [...values, id],
  );
}

export async function getAllSessions(): Promise<SleepSession[]> {
  const result = await getDb().execute(
    `SELECT * FROM sessions ORDER BY startedAt DESC`,
  );
  return (result.rows ?? []) as unknown as SleepSession[];
}

export async function getSession(id: string): Promise<SleepSession | null> {
  const result = await getDb().execute(
    `SELECT * FROM sessions WHERE id = ? LIMIT 1`,
    [id],
  );
  const rows = result.rows ?? [];
  return rows.length > 0 ? (rows[0] as unknown as SleepSession) : null;
}

export async function deleteSession(id: string): Promise<void> {
  await getDb().execute(`DELETE FROM sessions WHERE id = ?`, [id]);
}

/** Persist ML analysis results into the sessions row. */
export async function updateSessionAnalysis(
  id: string,
  fields: {
    ahi: number;
    severity: string;
    apneaCount: number;
    hypopneaCount: number;
    longestApneaSec: number;
  },
): Promise<void> {
  await getDb().execute(
    `UPDATE sessions
     SET ahi = ?, severity = ?, apneaCount = ?, hypopneaCount = ?, longestApneaSec = ?
     WHERE id = ?`,
    [fields.ahi, fields.severity, fields.apneaCount, fields.hypopneaCount, fields.longestApneaSec, id],
  );
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function insertEvents(
  events: Array<Omit<AudioEvent, 'id'> & {id?: string}>,
): Promise<void> {
  const d = getDb();
  for (const e of events) {
    const id = e.id ?? `${e.sessionId}_${e.startOffsetSec}_${e.type}`;
    await d.execute(
      `INSERT OR IGNORE INTO events
         (id, sessionId, type, startOffsetSec, durationSec, confidence)
       VALUES (?,?,?,?,?,?)`,
      [id, e.sessionId, e.type, e.startOffsetSec, e.durationSec, e.confidence],
    );
  }
}

export async function getEventsForSession(sessionId: string): Promise<AudioEvent[]> {
  const result = await getDb().execute(
    `SELECT * FROM events WHERE sessionId = ? ORDER BY startOffsetSec`,
    [sessionId],
  );
  return (result.rows ?? []) as unknown as AudioEvent[];
}
