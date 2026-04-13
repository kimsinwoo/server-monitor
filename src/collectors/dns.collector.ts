import dns from 'node:dns/promises';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class DnsCollector extends BaseCollector {
  readonly id = 'dns';
  readonly category: Category = 'dns';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    for (const check of this.config.dns.checks) {
      const slowMs = check.slowThresholdMs ?? 500;
      const started = Date.now();
      try {
        const resolved = await dns.lookup(check.hostname, { all: true });
        const resolveTimeMs = Date.now() - started;
        const resolvedIps = resolved.map((r) => r.address);
        const detail = {
          domain: check.hostname,
          resolvedIps,
          expectedIps: check.expectedIps ?? [],
          resolveTimeMs,
        };

        if (resolveTimeMs > slowMs) {
          const ev = await this.evaluate(true, {
            serverId: check.serverId,
            category: 'dns',
            severity: 'warning',
            title: 'DNS 해석 지연',
            message: `${check.hostname} ${resolveTimeMs}ms`,
            detail,
          });
          if (ev) events.push(ev);
        }

        if (check.expectedIps?.length) {
          const set = new Set(resolvedIps);
          const mismatch = !check.expectedIps.every((ip) => set.has(ip));
          if (mismatch) {
            const ev = await this.evaluate(true, {
              serverId: check.serverId,
              category: 'dns',
              severity: 'critical',
              title: 'DNS 결과 불일치',
              message: `예상과 다른 IP: ${resolvedIps.join(', ')}`,
              detail,
            });
            if (ev) events.push(ev);
          }
        }
      } catch (err) {
        const resolveTimeMs = Date.now() - started;
        const ev = await this.evaluate(true, {
          serverId: check.serverId,
          category: 'dns',
          severity: 'critical',
          title: 'DNS 해석 실패',
          message: `${check.hostname}: ${err instanceof Error ? err.message : String(err)}`,
          detail: {
            domain: check.hostname,
            resolvedIps: [],
            expectedIps: check.expectedIps ?? [],
            resolveTimeMs,
          },
        });
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}
