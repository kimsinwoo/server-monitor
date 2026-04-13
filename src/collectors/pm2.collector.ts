import { createRequire } from 'node:module';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';
import { logger } from '../utils/logger.js';

const require = createRequire(import.meta.url);

type Pm2Proc = {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string; restart_time?: number; axm_monitor?: { [k: string]: { value?: number } } };
  monit?: { memory?: number; cpu?: number };
};

export class Pm2Collector extends BaseCollector {
  readonly id = 'pm2';
  readonly category: Category = 'pm2';
  readonly intervalMs: number;
  private lastRestartMap = new Map<string, number>();

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    if (!this.config.pm2.enabled) return [];
    const events: MonitorEvent[] = [];
    try {
      const pm2 = require('pm2') as {
        connect: (cb: (err: Error | null) => void) => void;
        list: (cb: (err: Error | null, res: Pm2Proc[]) => void) => void;
        disconnect: () => void;
      };
      const list = await new Promise<Pm2Proc[]>((resolve, reject) => {
        pm2.connect((err: Error | null) => {
          if (err) {
            reject(err);
            return;
          }
          pm2.list((e: Error | null, res: Pm2Proc[]) => {
            pm2.disconnect();
            if (e) reject(e);
            else resolve(res ?? []);
          });
        });
      });

      for (const proc of list) {
        const name = proc.name ?? 'unknown';
        const status = proc.pm2_env?.status ?? 'unknown';
        const restartCount = proc.pm2_env?.restart_time ?? 0;
        const memory = proc.monit?.memory ?? 0;
        const cpu = proc.monit?.cpu ?? 0;
        const detail = {
          processName: name,
          pid: proc.pid,
          status,
          restartCount,
          memory,
          cpu,
          uptime: proc.pm2_env?.axm_monitor?.['Loop delay']?.value,
        };

        if (status === 'errored' || status === 'stopped') {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'pm2',
            severity: 'critical',
            title: `PM2 프로세스 ${status}`,
            message: `${name} (pid ${proc.pid})`,
            detail,
          });
          if (ev) events.push(ev);
        }

        const prev = this.lastRestartMap.get(name);
        if (prev !== undefined && restartCount > prev) {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'pm2',
            severity: 'error',
            title: 'PM2 재시작 증가',
            message: `${name} restart ${prev} → ${restartCount}`,
            detail,
          });
          if (ev) events.push(ev);
        }
        this.lastRestartMap.set(name, restartCount);

        const memMb = memory / (1024 * 1024);
        if (memMb > this.config.pm2.memThresholdMB) {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'pm2',
            severity: 'warning',
            title: 'PM2 메모리 과다',
            message: `${name} ${memMb.toFixed(0)}MB (임계 ${this.config.pm2.memThresholdMB}MB)`,
            detail,
          });
          if (ev) events.push(ev);
        }

        if (cpu > this.config.pm2.cpuThresholdPercent) {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'pm2',
            severity: 'warning',
            title: 'PM2 CPU 과다',
            message: `${name} CPU ${cpu}%`,
            detail,
          });
          if (ev) events.push(ev);
        }
      }
    } catch (err) {
      logger.warn('pm2 collector skipped', { error: String(err) });
    }
    return events;
  }
}
