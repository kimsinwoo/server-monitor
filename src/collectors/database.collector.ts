import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';
import { logger } from '../utils/logger.js';

export class DatabaseCollector extends BaseCollector {
  readonly id = 'database';
  readonly category: Category = 'database';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    for (const db of this.config.databases) {
      if (db.type === 'mongoose') {
        logger.debug('mongoose collector skipped (not implemented)', { serverId: db.serverId });
        continue;
      }
      const slowMs = db.slowQueryThresholdMs ?? 1000;
      try {
        if (db.type === 'pg') {
          const { Client } = await import('pg');
          const client = new Client({ connectionString: db.connectionString });
          const started = Date.now();
          await client.connect();
          await client.query('SELECT 1');
          const queryTimeMs = Date.now() - started;
          await client.end();
          const detail = {
            dbType: db.type,
            host: db.host,
            database: db.database,
            queryTimeMs,
            activeConnections: undefined,
          };
          if (queryTimeMs > slowMs) {
            const ev = await this.evaluate(true, {
              serverId: db.serverId,
              category: 'database',
              severity: 'warning',
              title: 'DB 슬로우 쿼리',
              message: `ping ${queryTimeMs}ms`,
              detail,
            });
            if (ev) events.push(ev);
          }
        } else if (db.type === 'mysql') {
          const mysql = await import('mysql2/promise');
          const started = Date.now();
          const conn = await mysql.createConnection({
            host: db.host,
            port: db.port,
            user: db.user,
            password: db.password,
            database: db.database,
          });
          await conn.query('SELECT 1');
          const queryTimeMs = Date.now() - started;
          await conn.end();
          if (queryTimeMs > slowMs) {
            const ev = await this.evaluate(true, {
              serverId: db.serverId,
              category: 'database',
              severity: 'warning',
              title: 'DB 슬로우 쿼리',
              message: `ping ${queryTimeMs}ms`,
              detail: {
                dbType: db.type,
                host: db.host,
                database: db.database,
                queryTimeMs,
              },
            });
            if (ev) events.push(ev);
          }
        } else if (db.type === 'better-sqlite3') {
          const Database = (await import('better-sqlite3')).default;
          const path = db.connectionString ?? db.database ?? ':memory:';
          const started = Date.now();
          const sql = new Database(path);
          sql.prepare('SELECT 1').get();
          const queryTimeMs = Date.now() - started;
          sql.close();
          if (queryTimeMs > slowMs) {
            const ev = await this.evaluate(true, {
              serverId: db.serverId,
              category: 'database',
              severity: 'warning',
              title: 'DB 슬로우 쿼리',
              message: `sqlite ping ${queryTimeMs}ms`,
              detail: {
                dbType: db.type,
                host: path,
                database: path,
                queryTimeMs,
              },
            });
            if (ev) events.push(ev);
          }
        }
      } catch (err) {
        const ev = await this.evaluate(true, {
          serverId: db.serverId,
          category: 'database',
          severity: 'critical',
          title: 'DB 연결 실패',
          message: err instanceof Error ? err.message : String(err),
          detail: { dbType: db.type, host: db.host, database: db.database },
        });
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}
