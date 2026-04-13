import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MonitorConfig, MonitorEvent } from '../types/monitor.types.js';
import { logger } from '../utils/logger.js';

export type EventsSummary = {
  date: string;
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
};

export class EventStore {
  private db: Database.Database | null = null;
  private jsonPath: string | null = null;

  constructor(private readonly config: MonitorConfig['store']) {
    if (config.type === 'sqlite') {
      const p = config.path ?? './data/monitor.db';
      fs.mkdirSync(path.dirname(p), { recursive: true });
      this.db = new Database(p);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
      `);
    } else if (config.type === 'json') {
      this.jsonPath = config.path ?? './data/monitor-events.json';
      fs.mkdirSync(path.dirname(this.jsonPath), { recursive: true });
      if (!fs.existsSync(this.jsonPath)) {
        fs.writeFileSync(this.jsonPath, '{}', 'utf8');
      }
    } else {
      throw new Error(`STORE_TYPE ${config.type} is not implemented; use sqlite or json`);
    }
  }

  async appendEvent(event: MonitorEvent): Promise<void> {
    const date = event.timestamp.slice(0, 10);
    const payload = JSON.stringify(event);
    let attempt = 0;
    const max = 3;
    while (attempt < max) {
      try {
        if (this.db) {
          this.db.prepare('INSERT INTO events (id, date, data) VALUES (?, ?, ?)').run(
            event.id,
            date,
            payload,
          );
        } else if (this.jsonPath) {
          const raw = fs.readFileSync(this.jsonPath, 'utf8');
          const all = JSON.parse(raw || '{}') as Record<string, MonitorEvent[]>;
          const list = all[date] ?? [];
          list.push(event);
          all[date] = list;
          fs.writeFileSync(this.jsonPath, JSON.stringify(all), 'utf8');
        }
        return;
      } catch (err) {
        attempt += 1;
        logger.warn('appendEvent retry', { attempt, err: String(err) });
        if (attempt >= max) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }

  async getEventsForDate(date: string): Promise<MonitorEvent[]> {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT data FROM events WHERE date = ? ORDER BY rowid ASC')
        .all(date) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as MonitorEvent);
    }
    if (this.jsonPath) {
      const raw = fs.readFileSync(this.jsonPath, 'utf8');
      const all = JSON.parse(raw || '{}') as Record<string, MonitorEvent[]>;
      return all[date] ?? [];
    }
    return [];
  }

  async getEventsSummary(date: string): Promise<EventsSummary> {
    const events = await this.getEventsForDate(date);
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const e of events) {
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    }
    return {
      date,
      total: events.length,
      bySeverity,
      byCategory,
    };
  }

  purgeOlderThanDays(ttlDays: number): void {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - ttlDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (this.db) {
      this.db.prepare('DELETE FROM events WHERE date < ?').run(cutoffStr);
    } else if (this.jsonPath) {
      const raw = fs.readFileSync(this.jsonPath, 'utf8');
      const all = JSON.parse(raw || '{}') as Record<string, MonitorEvent[]>;
      for (const k of Object.keys(all)) {
        if (k < cutoffStr) delete all[k];
      }
      fs.writeFileSync(this.jsonPath, JSON.stringify(all), 'utf8');
    }
  }

  close(): void {
    this.db?.close();
  }
}
