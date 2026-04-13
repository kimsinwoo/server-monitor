import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('EMAIL_RECIPIENTS 는 쉼표·세미콜론·줄바꿈으로 여러 주소를 받는다', () => {
    vi.stubEnv('MONITOR_HUB_TELEMETRY_QUEUE', 'false');
    vi.stubEnv('MQTT_BROKER_URL', '');
    vi.stubEnv('DB_HOST', '');
    vi.stubEnv('EMAIL_RECIPIENTS', 'a@x.com; b@y.com\na@x.com , c@z.com');
    const c = loadMonitorConfig();
    expect(c.email.recipients).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
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

  it('MONITOR_HUB_ENV_PATH 없이 front/dist 경로만으로 back/.env 를 병합한다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-hub-'));
    fs.mkdirSync(path.join(root, 'front', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'back'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'back', '.env'),
      'MQTT_BROKER_URL=mqtt://broker.test\nDB_HOST=10.0.0.1\nDB_USERNAME=u\nDB_PASSWORD=p\nDB_DATABASE=d\n',
      'utf8',
    );

    vi.stubEnv('MONITOR_SERVER_ID', 'hub-tmp');
    vi.stubEnv('MONITOR_HUB_TELEMETRY_QUEUE', 'false');
    vi.stubEnv('MONITOR_HUB_ENV_PATH', '');
    vi.stubEnv('MQTT_BROKER_URL', '');
    vi.stubEnv('DB_HOST', '');
    vi.stubEnv('DB_USERNAME', '');
    vi.stubEnv('DB_PASSWORD', '');
    vi.stubEnv('DB_DATABASE', '');
    vi.stubEnv('MONITOR_FRONTEND_BUILD_DIR', path.join(root, 'front', 'dist'));

    const c = loadMonitorConfig();
    expect(c.mqtt.brokers).toHaveLength(1);
    expect(c.mqtt.brokers[0]?.url).toBe('mqtt://broker.test');
    expect(c.databases).toHaveLength(1);
    expect(c.databases[0]).toMatchObject({ type: 'mysql', host: '10.0.0.1' });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hub back/.env 의 PORT 가 병합되면 큐 메트릭 URL 이 127.0.0.1:PORT 를 쓴다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-hub-port-'));
    fs.mkdirSync(path.join(root, 'front', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'back'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'back', '.env'),
      'PORT=7777\nMQTT_BROKER_URL=mqtt://broker.test\nDB_HOST=127.0.0.1\n',
      'utf8',
    );

    vi.stubEnv('MONITOR_SERVER_ID', 'hub-port');
    vi.stubEnv('MONITOR_FRONTEND_BUILD_DIR', path.join(root, 'front', 'dist'));
    vi.stubEnv('MONITOR_HUB_INTERNAL_API_ORIGIN', '');
    vi.stubEnv('MONITOR_HUB_API_ORIGIN', '');
    vi.stubEnv('MONITOR_HUB_SITE_ORIGIN', '');
    vi.stubEnv('MONITOR_HUB_QUEUE_METRICS_URL', '');
    vi.stubEnv('MQTT_BROKER_URL', '');
    vi.stubEnv('DB_HOST', '');

    const c = loadMonitorConfig();
    const hubQ = c.queues.find((q) => q.type === 'hub-telemetry');
    expect(hubQ).toBeDefined();
    expect((hubQ!.connection as { url: string }).url).toBe(
      'http://127.0.0.1:7777/api/monitor/queue-metrics',
    );

    fs.rmSync(root, { recursive: true, force: true });
  });
});
