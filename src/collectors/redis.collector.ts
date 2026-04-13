import { Redis } from 'ioredis';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class RedisCollector extends BaseCollector {
  readonly id = 'redis';
  readonly category: Category = 'redis';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    for (const inst of this.config.redis.instances) {
      const client = new Redis({
        host: inst.host,
        port: inst.port ?? 6379,
        password: inst.password,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
      });
      try {
        await client.connect();
        const infoRaw = await client.info('memory');
        const replication = await client.info('replication');
        await client.quit();

        const maxMem = this.parseInfoNumber(infoRaw, 'maxmemory');
        const usedMem = this.parseInfoNumber(infoRaw, 'used_memory');
        const evicted = this.parseInfoNumber(infoRaw, 'evicted_keys');
        const hits = this.parseInfoNumber(infoRaw, 'keyspace_hits');
        const misses = this.parseInfoNumber(infoRaw, 'keyspace_misses');
        const usedMB = usedMem / (1024 * 1024);
        const maxMB = maxMem > 0 ? maxMem / (1024 * 1024) : 0;
        const hitRate = hits + misses > 0 ? hits / (hits + misses) : 1;
        const slaves = (replication.match(/connected_slaves:(\d+)/)?.[1] ?? '0').trim();
        const connectedSlaves = Number.parseInt(slaves, 10) || 0;

        const detail = {
          host: inst.host,
          usedMemoryMB: usedMB,
          maxMemoryMB: maxMB,
          evictedKeys: evicted,
          hitRate,
        };

        if (maxMem > 0 && usedMem > maxMem * 0.9) {
          const ev = await this.evaluate(true, {
            serverId: inst.serverId,
            category: 'redis',
            severity: 'error',
            title: 'Redis 메모리 한계 근접',
            message: `${inst.host} used ${usedMB.toFixed(0)}MB / max ${maxMB.toFixed(0)}MB`,
            detail,
          });
          if (ev) events.push(ev);
        }

        if (inst.expectedSlaves !== undefined && connectedSlaves < inst.expectedSlaves) {
          const ev = await this.evaluate(true, {
            serverId: inst.serverId,
            category: 'redis',
            severity: 'error',
            title: 'Redis 복제 슬레이브 부족',
            message: `connected_slaves ${connectedSlaves}, 기대 ${inst.expectedSlaves}`,
            detail: { ...detail, connectedSlaves },
          });
          if (ev) events.push(ev);
        }
      } catch (err) {
        const ev = await this.evaluate(true, {
          serverId: inst.serverId,
          category: 'redis',
          severity: 'critical',
          title: 'Redis 연결 실패',
          message: err instanceof Error ? err.message : String(err),
          detail: { host: inst.host },
        });
        if (ev) events.push(ev);
      } finally {
        client.disconnect();
      }
    }
    return events;
  }

  private parseInfoNumber(block: string, key: string): number {
    const m = block.match(new RegExp(`${key}:(\\d+)`, 'm'));
    return m?.[1] ? Number.parseInt(m[1], 10) : 0;
  }
}
