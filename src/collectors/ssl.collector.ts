import tls from 'node:tls';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

function daysBetween(a: Date, b: Date): number {
  return Math.ceil((a.getTime() - b.getTime()) / 86400000);
}

export class SslCollector extends BaseCollector {
  readonly id = 'ssl';
  readonly category: Category = 'ssl';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    const serverId = this.config.servers[0]?.id ?? 'server-01';

    for (const domain of this.config.ssl.domains) {
      try {
        const cert = await new Promise<tls.DetailedPeerCertificate | null>((resolve, reject) => {
          const socket = tls.connect(
            { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
            () => {
              const c = socket.getPeerCertificate(true);
              socket.end();
              resolve(c && Object.keys(c).length ? c : null);
            },
          );
          socket.on('error', reject);
        });

        if (!cert?.valid_to) continue;
        const expiresAt = new Date(cert.valid_to);
        const daysRemaining = daysBetween(expiresAt, new Date());
        const issuer = typeof cert.issuer === 'object' && cert.issuer?.O ? String(cert.issuer.O) : 'unknown';
        const detail = { domain, expiresAt: expiresAt.toISOString(), daysRemaining, issuer };

        if (daysRemaining < 0) {
          const ev = await this.evaluate(true, {
            serverId,
            category: 'ssl',
            severity: 'critical',
            title: 'SSL 인증서 만료됨',
            message: `${domain} 만료일 ${cert.valid_to}`,
            detail,
          });
          if (ev) events.push(ev);
        } else if (daysRemaining <= this.config.ssl.criticalDaysAhead) {
          const ev = await this.evaluate(true, {
            serverId,
            category: 'ssl',
            severity: 'critical',
            title: 'SSL 인증서 만료 임박',
            message: `${domain} D-${daysRemaining}`,
            detail,
          });
          if (ev) events.push(ev);
        } else if (daysRemaining <= this.config.ssl.warningDaysAhead) {
          const ev = await this.evaluate(true, {
            serverId,
            category: 'ssl',
            severity: 'warning',
            title: 'SSL 인증서 만료 주의',
            message: `${domain} D-${daysRemaining}`,
            detail,
          });
          if (ev) events.push(ev);
        }
      } catch (err) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'ssl',
          severity: 'error',
          title: 'SSL 검사 실패',
          message: `${domain}: ${err instanceof Error ? err.message : String(err)}`,
          detail: { domain, error: String(err) },
        });
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}
