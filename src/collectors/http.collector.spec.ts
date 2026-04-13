import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { HttpCollector } from './http.collector.js';
import type { MonitorConfig } from '../types/monitor.types.js';

vi.mock('axios');
vi.mock('../utils/system-snapshot.js', () => ({
  captureSystemSnapshot: vi.fn(async () => ({
    cpuPercent: 10,
    ramUsedPercent: 40,
    ramUsedMB: 1000,
    ramTotalMB: 4000,
    diskUsedPercent: 50,
    diskUsedGB: 100,
    diskTotalGB: 200,
    networkRxMBps: 0,
    networkTxMBps: 0,
    loadAvg1m: 0.5,
    loadAvg5m: 0.4,
    loadAvg15m: 0.3,
    uptime: 3600,
  })),
}));

function minimalConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    timezone: 'Asia/Seoul',
    collectIntervalMs: 60_000,
    servers: [{ id: 's1' }],
    thresholds: {
      cpu: { warning: 75, critical: 90 },
      ram: { warning: 80, critical: 90 },
      disk: { warning: 80, critical: 90 },
      responseTime: { warning: 100, critical: 5000 },
    },
    http: {
      endpoints: [
        {
          serverId: 's1',
          url: 'https://example.com/health',
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          slowThresholdMs: 50,
        },
      ],
    },
    mqtt: { brokers: [] },
    databases: [],
    pm2: { enabled: false, memThresholdMB: 512, cpuThresholdPercent: 80 },
    docker: { enabled: false, socketPath: '/var/run/docker.sock' },
    ssl: { domains: [], warningDaysAhead: 30, criticalDaysAhead: 7 },
    redis: { instances: [] },
    queues: [],
    logs: { files: [], patterns: [] },
    frontend: { buildDir: '', healthUrls: [] },
    dns: { checks: [] },
    email: {
      provider: 'smtp',
      recipients: [],
      from: 'a@b.com',
      smtp: { host: 'localhost', port: 587, user: '', pass: '' },
    },
    store: { type: 'sqlite', path: ':memory:', ttlDays: 30 },
    ...overrides,
  };
}

describe('HttpCollector', () => {
  beforeEach(() => {
    vi.mocked(axios.request).mockReset();
  });

  it('collect returns warning when response slower than slowThresholdMs', async () => {
    vi.mocked(axios.request).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { status: 200, data: '' };
    });
    const collector = new HttpCollector(minimalConfig());
    const events = await collector.collect();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.severity).toBe('warning');
    expect(events[0]?.category).toBe('http');
  });

  it('collect returns error when status mismatches', async () => {
    vi.mocked(axios.request).mockResolvedValue({
      status: 500,
      data: '',
    });
    const cfg = minimalConfig();
    cfg.http.endpoints[0]!.slowThresholdMs = 100_000;
    const collector = new HttpCollector(cfg);
    const events = await collector.collect();
    expect(events.some((e) => e.severity === 'error')).toBe(true);
  });
});
