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

/** JSON 모드: 일별 .jsonl 샤드만 append — 구 단일 JSON 전체 read/write 제거 */
function shardDirForJsonConfig(configPath: string): string {
  if (configPath.endsWith('.json')) {
    return path.join(path.dirname(configPath), `${path.basename(configPath, '.json')}-shards`);
  }
  return path.resolve(configPath);
}

export class EventStore {
  private db: Database.Database | null = null;
  /** 일별 `YYYY-MM-DD.jsonl` 디렉터리 (STORE_TYPE=json) */
  private jsonShardDir: string | null = null;

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
      const p = config.path ?? './data/monitor-events.json';
      this.jsonShardDir = shardDirForJsonConfig(p);
      fs.mkdirSync(this.jsonShardDir, { recursive: true });
      if (p.endsWith('.json')) {
        const legacy = path.resolve(p);
        if (fs.existsSync(legacy)) {
          this.migrateLegacySingleJsonFile(legacy);
        }
      }
    } else {
      throw new Error(`STORE_TYPE ${config.type} is not implemented; use sqlite or json`);
    }
  }

  /** 구버전 단일 monitor-events.json → 일별 jsonl 로 이전 후 .migrated.bak */
  private migrateLegacySingleJsonFile(legacyPath: string): void {
    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const all = JSON.parse(raw || '{}') as Record<string, unknown>;
      if (!all || typeof all !== 'object' || Array.isArray(all)) {
        fs.renameSync(legacyPath, `${legacyPath}.migrated.bak`);
        return;
      }
      for (const [date, list] of Object.entries(all)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(list)) continue;
        const shard = path.join(this.jsonShardDir!, `${date}.jsonl`);
        const lines = list
          .filter((x) => x && typeof x === 'object')
          .map((e) => JSON.stringify(e as MonitorEvent))
          .join('\n');
        if (lines) fs.appendFileSync(shard, `${lines}\n`, 'utf8');
      }
      fs.renameSync(legacyPath, `${legacyPath}.migrated.bak`);
      logger.info('event store: migrated legacy json to daily shards', { legacyPath, shardDir: this.jsonShardDir });
    } catch (err) {
      logger.warn('event store: legacy json migrate failed', { legacyPath, err: String(err) });
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
        } else if (this.jsonShardDir) {
          const shard = path.join(this.jsonShardDir, `${date}.jsonl`);
          fs.appendFileSync(shard, `${payload}\n`, 'utf8');
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
    if (this.jsonShardDir) {
      const shard = path.join(this.jsonShardDir, `${date}.jsonl`);
      if (!fs.existsSync(shard)) return [];
      const raw = fs.readFileSync(shard, 'utf8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      return lines.map((l) => JSON.parse(l) as MonitorEvent);
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
    } else if (this.jsonShardDir) {
      let names: string[];
      try {
        names = fs.readdirSync(this.jsonShardDir);
      } catch {
        return;
      }
      for (const name of names) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        const day = m?.[1];
        if (day !== undefined && day < cutoffStr) {
          try {
            fs.unlinkSync(path.join(this.jsonShardDir, name));
          } catch (err) {
            logger.warn('purge shard failed', { name, err: String(err) });
          }
        }
      }
    }
  }

  close(): void {
    this.db?.close();
  }
}
