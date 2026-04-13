import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMonitorConfig } from './monitor.config.js';

describe('loadMonitorConfig — 실서버(허브) 오리진 병합', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('MONITOR_HUB_* 설정 시 /api/health·정적 경로 검사가 포함된다', () => {
    vi.stubEnv('MONITOR_SERVER_ID', 'hub-prod');
    vi.stubEnv('MONITOR_HUB_SITE_ORIGIN', 'http://example.com');
    vi.stubEnv('MONITOR_HUB_API_ORIGIN', 'http://127.0.0.1:5001');
    vi.stubEnv('MONITOR_HUB_TELEMETRY_QUEUE', 'false');
    vi.stubEnv('MQTT_BROKER_URL', '');
    vi.stubEnv('DB_HOST', '');
    const c = loadMonitorConfig();
    const urls = c.http.endpoints.map((e) => e.url);
    expect(urls).toContain('http://example.com/');
    expect(urls).toContain('http://example.com/index.html');
    expect(urls).toContain('http://127.0.0.1:5001/api/health');
    expect(c.http.endpoints.every((e) => e.serverId === 'hub-prod')).toBe(true);
  });

  it('MONITOR_HUB_API_ORIGIN 이 비어 있으면 SITE 와 같은 호스트로 /api/health', () => {
    vi.stubEnv('MONITOR_SERVER_ID', 'hub-1');
    vi.stubEnv('MONITOR_HUB_SITE_ORIGIN', 'https://creamoff.example');
    vi.stubEnv('MONITOR_HUB_TELEMETRY_QUEUE', 'false');
    vi.stubEnv('MQTT_BROKER_URL', '');
    vi.stubEnv('DB_HOST', '');
    const c = loadMonitorConfig();
    const urls = c.http.endpoints.map((e) => e.url);
    expect(urls).toContain('https://creamoff.example/api/health');
  });

  it('MONITOR_HTTP_ENDPOINTS 가 동일 URL이면 허브 기본값을 덮어쓴다', () => {
    vi.stubEnv('MONITOR_HUB_TELEMETRY_QUEUE', 'false');
    vi.stubEnv('MQTT_BROKER_URL', '');
    vi.stubEnv('DB_HOST', '');
    vi.stubEnv('MONITOR_HUB_API_ORIGIN', 'http://127.0.0.1:5001');
    vi.stubEnv(
      'MONITOR_HTTP_ENDPOINTS',
      JSON.stringify([
        {
          serverId: 'custom',
          url: 'http://127.0.0.1:5001/api/health',
          method: 'GET',
          expectedStatus: 503,
          timeoutMs: 1000,
          slowThresholdMs: 100,
        },
      ]),
    );
    const c = loadMonitorConfig();
    const ep = c.http.endpoints.find((e) => e.url.endsWith('/api/health'));
    expect(ep?.expectedStatus).toBe(503);
    expect(ep?.serverId).toBe('custom');
  });
});
