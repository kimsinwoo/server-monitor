import axios from 'axios';
import type { Category, MonitorConfig, MonitorEvent, Severity } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

type HubWatchIncident = {
  id?: string;
  ts?: number;
  type?: string;
  severity?: string;
  hubId?: string;
  message?: string;
  detail?: Record<string, unknown>;
};

type HubWatchResponse = {
  ok?: boolean;
  incidents?: HubWatchIncident[];
  telemetryGapSummary?: unknown;
  config?: Record<string, unknown>;
};

function asSeverity(s: string | undefined): Severity {
  if (s === 'critical' || s === 'error' || s === 'warning' || s === 'info') return s;
  return 'warning';
}

export class HubWatchCollector extends BaseCollector {
  readonly id = 'hub-watch';
  readonly category: Category = 'hub';
  readonly intervalMs: number;
  private _sinceMs = 0;
  private _primed = false;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const hw = this.config.hubWatch;
    if (!hw?.url) return [];

    if (!this._primed) {
      this._primed = true;
      this._sinceMs = Date.now();
      return [];
    }

    const events: MonitorEvent[] = [];
    const fallbackServerId = this.config.servers[0]?.id ?? 'server-01';
    const serverId = this.config.queues.find((q) => q.type === 'hub-telemetry')?.serverId ?? fallbackServerId;

    try {
      const headers: Record<string, string> = {};
      if (hw.token) headers['X-Monitor-Token'] = hw.token;
      const url = `${hw.url.replace(/\?$/, '').replace(/\/$/, '')}?since=${this._sinceMs}`;
      const res = await axios.get(url, {
        timeout: 12_000,
        validateStatus: () => true,
        headers,
      });

      if (res.status !== 200) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'hub',
          severity: 'error',
          title: '허브 감시 API HTTP 오류',
          message: `${hw.url} → ${res.status}`,
          detail: { url: hw.url, status: res.status, source: 'hub-watch' },
        });
        if (ev) events.push(ev);
        return events;
      }

      const data = res.data as HubWatchResponse;
      const list = Array.isArray(data.incidents) ? data.incidents : [];
      let maxTs = this._sinceMs;
      for (const inc of list) {
        const ts = typeof inc.ts === 'number' ? inc.ts : 0;
        if (ts > maxTs) maxTs = ts;
        const sev = asSeverity(inc.severity);
        const ev = await this.evaluate(true, {
          serverId,
          category: 'hub',
          severity: sev,
          title: `[허브] ${inc.type ?? 'incident'} — ${inc.hubId ?? 'unknown'}`,
          message: String(inc.message ?? '').slice(0, 500),
          detail: {
            source: 'hub-watch',
            incidentId: inc.id,
            incidentType: inc.type,
            hubId: inc.hubId,
            hubIncident: inc,
            apiConfig: data.config,
          },
        });
        if (ev) events.push(ev);
      }
      this._sinceMs = Math.max(this._sinceMs, maxTs);
    } catch (err) {
      const ev = await this.evaluate(true, {
        serverId,
        category: 'hub',
        severity: 'error',
        title: '허브 감시 API 요청 실패',
        message: String(err).slice(0, 500),
        detail: { url: hw.url, source: 'hub-watch' },
      });
      if (ev) events.push(ev);
    }

    return events;
  }
}
