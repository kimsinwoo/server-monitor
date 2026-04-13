import axios, { type Method } from 'axios';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class HttpCollector extends BaseCollector {
  readonly id = 'http';
  readonly category: Category = 'http';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    for (const ep of this.config.http.endpoints) {
      const method = (ep.method ?? 'GET').toUpperCase() as Method;
      const expected = ep.expectedStatus ?? 200;
      const timeout = ep.timeoutMs ?? 10_000;
      const slowMs = ep.slowThresholdMs ?? this.config.thresholds.responseTime.warning;
      const started = Date.now();
      try {
        const res = await axios.request({
          url: ep.url,
          method,
          timeout,
          validateStatus: () => true,
        });
        const responseTimeMs = Date.now() - started;
        const detail = { statusCode: res.status, responseTimeMs, url: ep.url, method };

        if (res.status !== expected) {
          const ev = await this.evaluate(true, {
            serverId: ep.serverId,
            category: 'http',
            severity: 'error',
            title: `HTTP 상태 불일치 ${res.status}`,
            message: `${method} ${ep.url} 기대 ${expected}, 실제 ${res.status}`,
            detail,
          });
          if (ev) events.push(ev);
        } else if (responseTimeMs > slowMs) {
          const ev = await this.evaluate(true, {
            serverId: ep.serverId,
            category: 'http',
            severity: 'warning',
            title: 'HTTP 응답 지연',
            message: `${method} ${ep.url} ${responseTimeMs}ms (경고 ${slowMs}ms)`,
            detail,
          });
          if (ev) events.push(ev);
        }

        if (ep.bodyCheck && typeof res.data === 'string' && !res.data.includes(ep.bodyCheck)) {
          const ev = await this.evaluate(true, {
            serverId: ep.serverId,
            category: 'http',
            severity: 'error',
            title: 'HTTP 본문 검증 실패',
            message: `본문에 "${ep.bodyCheck}" 없음`,
            detail: { ...detail, bodyCheck: ep.bodyCheck },
          });
          if (ev) events.push(ev);
        }
      } catch (err) {
        const responseTimeMs = Date.now() - started;
        const detail = {
          url: ep.url,
          method,
          responseTimeMs,
          error: String(err),
        };
        const isSsl =
          axios.isAxiosError(err) &&
          (err.code === 'CERT_HAS_EXPIRED' ||
            err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            err.message.includes('SSL') ||
            err.message.includes('certificate'));
        const severity = 'critical';
        const isTimeout = axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT');
        const ev = await this.evaluate(true, {
          serverId: ep.serverId,
          category: 'http',
          severity,
          title: isTimeout ? 'HTTP 타임아웃' : isSsl ? 'HTTP SSL 오류' : 'HTTP 연결 실패',
          message: `${method} ${ep.url}: ${err instanceof Error ? err.message : String(err)}`,
          detail,
        });
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}
