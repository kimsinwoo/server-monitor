import { describe, it, expect } from 'vitest';
import { ReportBuilder } from './report.builder.js';
import type { MonitorEvent } from '../types/monitor.types.js';
import type { EventsSummary } from '../aggregator/event.store.js';

const snap = {
  cpuPercent: 12,
  ramUsedPercent: 88,
  ramUsedMB: 7000,
  ramTotalMB: 8000,
  diskUsedPercent: 55,
  diskUsedGB: 40,
  diskTotalGB: 100,
  networkRxMBps: 0,
  networkTxMBps: 0,
  loadAvg1m: 1.2,
  loadAvg5m: 1.1,
  loadAvg15m: 1.0,
  uptime: 7200,
};

function ev(overrides: Partial<MonitorEvent>): MonitorEvent {
  return {
    id: 'id-1',
    timestamp: '2026-04-13T06:00:00.000Z',
    category: 'http',
    severity: 'error',
    serverId: 'hub-01',
    title: 'HTTP 상태 불일치 404',
    message: 'GET https://example.com/missing 기대 200, 실제 404',
    detail: { url: 'https://example.com/missing', method: 'GET', statusCode: 404, responseTimeMs: 42 },
    systemSnapshot: snap,
    ...overrides,
  };
}

describe('ReportBuilder', () => {
  it('HTML에 메시지·세부 JSON·리소스 한 줄이 포함된다', async () => {
    const builder = new ReportBuilder();
    const events: MonitorEvent[] = [ev({})];
    const summary: EventsSummary = {
      date: '2026-04-13',
      total: 1,
      byCategory: { http: 1 },
      bySeverity: { critical: 0, error: 1, warning: 0, info: 0 },
    };
    const html = await builder.build(events, '2026-04-13', summary);
    expect(html).toContain('메시지');
    expect(html).toContain('GET https://example.com/missing');
    expect(html).toContain('세부(JSON)');
    expect(html).toContain('"statusCode": 404');
    expect(html).toContain('이벤트 시점 리소스:');
    expect(html).toContain('7000 / 8000 MB');
  });

  it('critical 권장 조치는 동일 유형을 한 번만 나열한다', async () => {
    const builder = new ReportBuilder();
    const dup = ev({
      severity: 'critical',
      category: 'system',
      title: '메모리 사용률 위험',
      message: 'RAM 91.0% (7280 / 8000 MB) · 임계 90%',
      detail: { ramUsedPercent: 91 },
      id: 'a',
    });
    const dup2 = { ...dup, id: 'b', timestamp: '2026-04-13T06:01:00.000Z' };
    const html = await builder.build([dup, dup2], '2026-04-13', {
      date: '2026-04-13',
      total: 2,
      byCategory: { system: 2 },
      bySeverity: { critical: 2, error: 0, warning: 0, info: 0 },
    });
    const checklistCards = html.split('border-left:2px solid #ff3b30').length - 1;
    expect(checklistCards).toBe(1);
  });
});
