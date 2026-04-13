import type { HttpEndpointConfig, MonitorConfig, ServerConfig } from '../types/monitor.types.js';
import {
  CPU_CRITICAL_THRESHOLD,
  CPU_WARNING_THRESHOLD,
  DISK_CRITICAL_THRESHOLD,
  DISK_WARNING_THRESHOLD,
  RAM_CRITICAL_THRESHOLD,
  RAM_WARNING_THRESHOLD,
} from './thresholds.js';

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(key: string): string[] {
  const v = process.env[key];
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function httpEndpointKey(e: HttpEndpointConfig): string {
  return `${(e.method ?? 'GET').toUpperCase()}\t${e.url}`;
}

/** nginx(공인) + Node(로컬 upstream) 등 실제 허브 배포에 맞춘 기본 HTTP 검사 */
function buildHubDerivedHttpEndpoints(serverId: string): HttpEndpointConfig[] {
  const out: HttpEndpointConfig[] = [];
  const site = process.env.MONITOR_HUB_SITE_ORIGIN?.trim();
  const api = process.env.MONITOR_HUB_API_ORIGIN?.trim();
  if (site) {
    const base = trimTrailingSlash(site);
    const timeoutMs = envInt('MONITOR_HUB_SITE_TIMEOUT_MS', 15_000);
    const slowThresholdMs = envInt('MONITOR_HUB_SITE_SLOW_MS', 3000);
    out.push({
      serverId,
      url: `${base}/`,
      method: 'GET',
      expectedStatus: 200,
      timeoutMs,
      slowThresholdMs,
    });
    out.push({
      serverId,
      url: `${base}/index.html`,
      method: 'GET',
      expectedStatus: 200,
      timeoutMs,
      slowThresholdMs,
    });
  }
  if (api) {
    const base = trimTrailingSlash(api);
    out.push({
      serverId,
      url: `${base}/api/health`,
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: envInt('MONITOR_HUB_API_TIMEOUT_MS', 8000),
      slowThresholdMs: envInt('MONITOR_HUB_API_SLOW_MS', 1500),
    });
  }
  return out;
}

function mergeHttpEndpoints(
  hubFirst: HttpEndpointConfig[],
  fromEnvJson: HttpEndpointConfig[],
): HttpEndpointConfig[] {
  const map = new Map<string, HttpEndpointConfig>();
  for (const e of hubFirst) {
    map.set(httpEndpointKey(e), e);
  }
  for (const e of fromEnvJson) {
    map.set(httpEndpointKey(e), e);
  }
  return [...map.values()];
}

export function loadMonitorConfig(): MonitorConfig {
  const serversFromEnv = parseJson(process.env.MONITOR_SERVERS, [] as ServerConfig[]);
  const servers: ServerConfig[] =
    serversFromEnv.length > 0
      ? serversFromEnv
      : [
          {
            id:
              process.env.MONITOR_SERVER_ID ??
              process.env.MONITOR_DEFAULT_SERVER_ID ??
              'talktail-hub-01',
          },
        ];

  const serverId = servers[0]?.id ?? 'talktail-hub-01';

  const fromEnvJson = parseJson(
    process.env.MONITOR_HTTP_ENDPOINTS,
    [] as MonitorConfig['http']['endpoints'],
  );
  const httpEndpoints = mergeHttpEndpoints(buildHubDerivedHttpEndpoints(serverId), fromEnvJson);

  const mqttBrokers = parseJson(
    process.env.MONITOR_MQTT_BROKERS,
    [] as MonitorConfig['mqtt']['brokers'],
  );

  const databases = parseJson(
    process.env.MONITOR_DATABASES,
    [] as MonitorConfig['databases'],
  );

  const redisInstances = parseJson(
    process.env.MONITOR_REDIS_INSTANCES,
    [] as MonitorConfig['redis']['instances'],
  );

  const queues = parseJson(process.env.MONITOR_QUEUES, [] as MonitorConfig['queues']);

  const dnsChecks = parseJson(
    process.env.MONITOR_DNS_CHECKS,
    [] as MonitorConfig['dns']['checks'],
  );

  const sslDomains = envList('MONITOR_SSL_DOMAINS');

  const frontendBuildDir = process.env.MONITOR_FRONTEND_BUILD_DIR?.trim() ?? '';

  return {
    timezone: process.env.MONITOR_TIMEZONE ?? 'Asia/Seoul',
    collectIntervalMs: envInt('COLLECT_INTERVAL_MS', 60_000),
    servers,
    thresholds: {
      cpu: {
        warning: envInt('THRESHOLD_CPU_WARNING', CPU_WARNING_THRESHOLD),
        critical: envInt('THRESHOLD_CPU_CRITICAL', CPU_CRITICAL_THRESHOLD),
      },
      ram: {
        warning: envInt('THRESHOLD_RAM_WARNING', RAM_WARNING_THRESHOLD),
        critical: envInt('THRESHOLD_RAM_CRITICAL', RAM_CRITICAL_THRESHOLD),
      },
      disk: {
        warning: envInt('THRESHOLD_DISK_WARNING', DISK_WARNING_THRESHOLD),
        critical: envInt('THRESHOLD_DISK_CRITICAL', DISK_CRITICAL_THRESHOLD),
      },
      responseTime: {
        warning: envInt('THRESHOLD_RESPONSE_WARNING_MS', 2000),
        critical: envInt('THRESHOLD_RESPONSE_CRITICAL_MS', 10000),
      },
    },
    http: { endpoints: httpEndpoints },
    mqtt: { brokers: mqttBrokers },
    databases,
    pm2: {
      enabled: process.env.MONITOR_PM2_ENABLED === 'true',
      memThresholdMB: envInt('MONITOR_PM2_MEM_MB', 512),
      cpuThresholdPercent: envInt('MONITOR_PM2_CPU_PERCENT', 80),
    },
    docker: {
      enabled: process.env.MONITOR_DOCKER_ENABLED === 'true',
      socketPath: process.env.MONITOR_DOCKER_SOCKET ?? '/var/run/docker.sock',
    },
    ssl: {
      domains: sslDomains,
      warningDaysAhead: envInt('MONITOR_SSL_WARNING_DAYS', 30),
      criticalDaysAhead: envInt('MONITOR_SSL_CRITICAL_DAYS', 7),
    },
    redis: { instances: redisInstances },
    queues,
    logs: {
      files: envList('MONITOR_LOG_FILES'),
      patterns: envList('MONITOR_LOG_PATTERNS').length
        ? envList('MONITOR_LOG_PATTERNS')
        : ['ERROR', 'CRITICAL', 'FATAL'],
      errorRateThreshold: envInt('MONITOR_LOG_ERROR_RATE', 10),
    },
    frontend: {
      buildDir: frontendBuildDir,
      healthUrls: envList('MONITOR_FRONTEND_HEALTH_URLS'),
    },
    dns: { checks: dnsChecks },
    email: {
      provider: (process.env.EMAIL_PROVIDER as MonitorConfig['email']['provider']) ?? 'smtp',
      recipients: envList('EMAIL_RECIPIENTS'),
      from: process.env.EMAIL_FROM ?? 'monitor@localhost',
      smtp: {
        host: process.env.SMTP_HOST ?? 'localhost',
        port: envInt('SMTP_PORT', 587),
        user: process.env.SMTP_USER ?? '',
        pass: process.env.SMTP_PASS ?? '',
      },
      sesRegion: process.env.AWS_SES_REGION,
      sendgridApiKey: process.env.SENDGRID_API_KEY,
      resendApiKey: process.env.RESEND_API_KEY,
    },
    store: {
      type: (process.env.STORE_TYPE as MonitorConfig['store']['type']) ?? 'sqlite',
      path: process.env.STORE_PATH ?? './data/monitor.db',
      ttlDays: envInt('STORE_TTL_DAYS', 30),
    },
  };
}
