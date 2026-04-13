import axios from 'axios';
import type { Category, MonitorConfig, MonitorEvent } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

type HubQueueMetrics = {
  ok?: boolean;
  telemetryQueueLength?: number;
  workerRunning?: boolean;
};

/** URL 별 마지막 정상 스냅샷(info) 시각 — 일간 리포트에 큐 상태가 보이도록 과도한 적재는 피함 */
const lastHubQueueInfoAtByUrl = new Map<string, number>();

function hubQueueInfoIntervalMs(): number {
  const raw = process.env.MONITOR_QUEUE_INFO_INTERVAL_MS;
  if (raw === '0') return 0;
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isFinite(n) && n > 0) return n;
  return 6 * 60 * 60 * 1000;
}

export class QueueCollector extends BaseCollector {
  readonly id = 'queue';
  readonly category: Category = 'queue';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    const fallbackServerId = this.config.servers[0]?.id ?? 'server-01';

    for (const q of this.config.queues) {
      if (q.type === 'hub-telemetry') {
        const row = await this.collectHubTelemetry(q, fallbackServerId);
        events.push(...row);
        continue;
      }
      // rabbitmq | bull | kafka: MONITOR_QUEUES JSON 확장 시 구현
    }

    return events;
  }

  private async collectHubTelemetry(
    q: MonitorConfig['queues'][number],
    fallbackServerId: string,
  ): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    const conn = q.connection as { url?: string; token?: string; criticalDepth?: number };
    if (!conn?.url) return events;

    const warnLen = q.queueDepthThreshold ?? 500;
    const critLen = typeof conn.criticalDepth === 'number' ? conn.criticalDepth : 5000;
    const serverId = q.serverId || fallbackServerId;

    try {
      const headers: Record<string, string> = {};
      if (conn.token) headers['X-Monitor-Token'] = conn.token;
      const res = await axios.get(conn.url, {
        timeout: 10_000,
        validateStatus: () => true,
        headers,
      });

      if (res.status !== 200) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'queue',
          severity: 'error',
          title: '허브 텔레메트리 큐 메트릭 HTTP 오류',
          message: `${conn.url} → ${res.status}`,
          detail: { url: conn.url, status: res.status },
        });
        if (ev) events.push(ev);
        return events;
      }

      const data = res.data as HubQueueMetrics;
      const len = data.telemetryQueueLength ?? 0;
      const running = data.workerRunning !== false;

      if (!running && len > 0) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'queue',
          severity: 'error',
          title: '텔레메트리 워커 정지·큐 적체',
          message: `대기 ${len}건, workerRunning=false`,
          detail: { ...data, url: conn.url },
        });
        if (ev) events.push(ev);
      } else if (len >= critLen) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'queue',
          severity: 'critical',
          title: '텔레메트리 큐 심각 적체',
          message: `대기 ${len}건 (임계 ${critLen})`,
          detail: { ...data, url: conn.url },
        });
        if (ev) events.push(ev);
      } else if (len >= warnLen) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'queue',
          severity: 'warning',
          title: '텔레메트리 큐 적체 경고',
          message: `대기 ${len}건 (경고 ${warnLen})`,
          detail: { ...data, url: conn.url },
        });
        if (ev) events.push(ev);
      } else {
        const intervalMs = hubQueueInfoIntervalMs();
        if (intervalMs > 0) {
          const now = Date.now();
          const prev = lastHubQueueInfoAtByUrl.get(conn.url) ?? 0;
          if (now - prev >= intervalMs) {
            lastHubQueueInfoAtByUrl.set(conn.url, now);
            const ev = await this.evaluate(true, {
              serverId,
              category: 'queue',
              severity: 'info',
              title: '텔레메트리 큐 스냅샷',
              message: `대기 ${len}건 · workerRunning=${String(data.workerRunning)}`,
              detail: { ...data, url: conn.url },
            });
            if (ev) events.push(ev);
          }
        }
      }
    } catch (err) {
      const ev = await this.evaluate(true, {
        serverId,
        category: 'queue',
        severity: 'critical',
        title: '허브 큐 메트릭 요청 실패',
        message: err instanceof Error ? err.message : String(err),
        detail: { url: conn.url },
      });
      if (ev) events.push(ev);
    }

    return events;
  }
}
