import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type {
  DatabaseConfig,
  HttpEndpointConfig,
  MonitorConfig,
  MqttBrokerConfig,
  ServerConfig,
  Severity,
} from '../types/monitor.types.js';
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

function parseSeverityEnv(key: string, fallback: Severity): Severity {
  const raw = (process.env[key] ?? '').trim().toLowerCase();
  if (raw === 'critical' || raw === 'error' || raw === 'warning' || raw === 'info') return raw;
  return fallback;
}

function envList(key: string): string[] {
  const v = process.env[key];
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 쉼표·세미콜론·줄바꿈으로 여러 수신자 지정 (대소문자만 다른 중복 제거) */
function envEmailRecipientsList(key: string): string[] {
  const v = process.env[key];
  if (!v) return [];
  const parts = v
    .split(/[,;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of parts) {
    const norm = addr.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(addr);
  }
  return out;
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

/**
 * nginx(공인 HTTPS) + Node(로컬 upstream) 등 허브 배포에 맞춘 기본 HTTP 검사.
 * MONITOR_HUB_API_ORIGIN 이 비어 있으면 MONITOR_HUB_SITE_ORIGIN 과 동일 호스트로 /api/health 검사
 * (HTTP 차단·HTTPS만 열린 경우 공인 도메인 한 번만 설정하면 됨).
 */
function buildHubDerivedHttpEndpoints(serverId: string): HttpEndpointConfig[] {
  const out: HttpEndpointConfig[] = [];
  const site = process.env.MONITOR_HUB_SITE_ORIGIN?.trim();
  const apiExplicit = process.env.MONITOR_HUB_API_ORIGIN?.trim();
  const apiBase = apiExplicit || site;
  const checkIndexHtml = process.env.MONITOR_HUB_CHECK_INDEX_HTML !== 'false';

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
    if (checkIndexHtml) {
      out.push({
        serverId,
        url: `${base}/index.html`,
        method: 'GET',
        expectedStatus: 200,
        timeoutMs,
        slowThresholdMs,
      });
    }
  }
  if (apiBase) {
    const base = trimTrailingSlash(apiBase);
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

/**
 * MONITOR_HUB_ENV_PATH 가 없을 때, 일반적인 허브 배치 경로에서 back/.env 추론.
 * (예: .../hub_project/front/dist + .../hub_project/back/logs/error.log)
 */
function inferHubBackEnvPathFromMonitorPaths(): string | undefined {
  const seen = new Set<string>();

  const tryPath = (candidate: string): string | undefined => {
    const abs = path.resolve(candidate);
    if (seen.has(abs)) return undefined;
    seen.add(abs);
    return fs.existsSync(abs) ? abs : undefined;
  };

  const fe = process.env.MONITOR_FRONTEND_BUILD_DIR?.trim();
  if (fe) {
    const norm = fe.replace(/\\/g, '/');
    const m = norm.match(/^(.*)\/front\/dist\/?$/i);
    if (m) {
      const hit = tryPath(path.join(m[1]!, 'back', '.env'));
      if (hit) return hit;
    }
  }

  for (const log of envList('MONITOR_LOG_FILES')) {
    const norm = log.replace(/\\/g, '/');
    const m = norm.match(/^(.*?\/back)\/logs\//i);
    if (m) {
      const hit = tryPath(path.join(m[1]!, '.env'));
      if (hit) return hit;
    }
  }

  return undefined;
}

/** hub_project/back/.env 경로 — monitor 쪽 키가 비어 있을 때만 채움 (MQTT·DB) */
function mergeHubBackEnvFile(): void {
  let p = process.env.MONITOR_HUB_ENV_PATH?.trim();
  if (!p) p = inferHubBackEnvPathFromMonitorPaths() ?? '';
  if (!p || !fs.existsSync(p)) return;
  try {
    const parsed = parseDotenv(fs.readFileSync(p, 'utf8'));
    const keys = [
      'MQTT_BROKER_URL',
      'MQTT_USERNAME',
      'MQTT_PASSWORD',
      'DB_HOST',
      'DB_PORT',
      'DB_USERNAME',
      'DB_PASSWORD',
      'DB_DATABASE',
    ] as const;
    for (const k of keys) {
      const v = parsed[k];
      if (v !== undefined && v !== '' && !String(process.env[k] ?? '').trim()) {
        process.env[k] = v;
      }
    }
    // 허브 listen 포트 — 모니터 프로세스의 process.env.PORT 와 섞이지 않게 별도 키
    const hubPort = parsed.PORT;
    if (
      hubPort !== undefined &&
      String(hubPort).trim() !== '' &&
      !String(process.env.MONITOR_HUB_BACK_PORT ?? '').trim()
    ) {
      process.env.MONITOR_HUB_BACK_PORT = String(hubPort).trim();
    }
  } catch {
    /* ignore */
  }
}

/** 허브 인메모리 텔레메트리 큐 — GET /api/monitor/queue-metrics */
function buildHubTelemetryQueueFromEnv(serverId: string): MonitorConfig['queues'] {
  if (process.env.MONITOR_HUB_TELEMETRY_QUEUE === 'false') return [];
  const explicit = process.env.MONITOR_HUB_QUEUE_METRICS_URL?.trim();
  const internal = process.env.MONITOR_HUB_INTERNAL_API_ORIGIN?.trim();
  const hubBackPort = process.env.MONITOR_HUB_BACK_PORT?.trim();
  const allowLocalQueue =
    process.env.MONITOR_HUB_QUEUE_USE_LOCALHOST !== 'false' &&
    process.env.MONITOR_HUB_PREFER_PUBLIC_QUEUE !== 'true';
  const localhostHub =
    allowLocalQueue && hubBackPort && /^\d+$/.test(hubBackPort)
      ? `http://127.0.0.1:${hubBackPort}`
      : '';
  // 동일 머신: 공인 HTTPS(api/site)보다 127.0.0.1:PORT 우선(토큰 없이 동작). 원격 모니터는 MONITOR_HUB_QUEUE_USE_LOCALHOST=false
  const api = process.env.MONITOR_HUB_API_ORIGIN?.trim();
  const site = process.env.MONITOR_HUB_SITE_ORIGIN?.trim();
  const base = internal || localhostHub || api || site;
  const url =
    explicit || (base ? `${trimTrailingSlash(base)}/api/monitor/queue-metrics` : '');
  if (!url) return [];
  return [
    {
      serverId,
      type: 'hub-telemetry',
      queueDepthThreshold: envInt('MONITOR_TELEMETRY_QUEUE_WARNING', 500),
      connection: {
        url,
        token: process.env.MONITOR_INTERNAL_TOKEN ?? '',
        criticalDepth: envInt('MONITOR_TELEMETRY_QUEUE_CRITICAL', 5000),
      },
    },
  ];
}

/** 허브 감시 API — queue-metrics 와 동일 베이스 URL 추론 가능 */
function buildHubWatchFromEnv(): MonitorConfig['hubWatch'] {
  const explicit = process.env.MONITOR_HUB_HUB_WATCH_URL?.trim();
  const token = process.env.MONITOR_INTERNAL_TOKEN?.trim();
  if (explicit) {
    return { url: explicit, token };
  }
  const qUrl = process.env.MONITOR_HUB_QUEUE_METRICS_URL?.trim();
  if (qUrl) {
    const u = qUrl.replace(/\/api\/monitor\/queue-metrics\/?$/i, '/api/monitor/hub-watch');
    return { url: u, token };
  }
  const internal = process.env.MONITOR_HUB_INTERNAL_API_ORIGIN?.trim();
  const hubBackPort = process.env.MONITOR_HUB_BACK_PORT?.trim();
  const allowLocal =
    process.env.MONITOR_HUB_QUEUE_USE_LOCALHOST !== 'false' &&
    process.env.MONITOR_HUB_PREFER_PUBLIC_QUEUE !== 'true';
  const localhostHub =
    allowLocal && hubBackPort && /^\d+$/.test(hubBackPort)
      ? `http://127.0.0.1:${hubBackPort}`
      : '';
  const api = process.env.MONITOR_HUB_API_ORIGIN?.trim();
  const site = process.env.MONITOR_HUB_SITE_ORIGIN?.trim();
  const base = internal || localhostHub || api || site;
  if (!base) return undefined;
  return {
    url: `${trimTrailingSlash(base)}/api/monitor/hub-watch`,
    token,
  };
}

/** hub_project/back/.env 와 동일 키를 monitor/.env 에 넣었을 때 MQTT 점검 자동 구성 */
function buildMqttFromHubEnv(serverId: string): MqttBrokerConfig[] {
  const url = process.env.MQTT_BROKER_URL?.trim();
  if (!url) return [];
  return [
    {
      serverId,
      url,
      username: process.env.MQTT_USERNAME?.trim() || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      clientId: process.env.MONITOR_MQTT_CLIENT_ID?.trim() || `monitor-${serverId}`,
      heartbeatTimeoutMs: envInt('MONITOR_MQTT_CONNECT_TIMEOUT_MS', 10_000),
    },
  ];
}

/** hub_project/back config 와 동일 DB_* 키로 MySQL 점검 자동 구성 */
function buildMysqlFromHubEnv(serverId: string): DatabaseConfig[] {
  const host = process.env.DB_HOST?.trim();
  if (!host) return [];
  return [
    {
      serverId,
      type: 'mysql',
      host,
      port: envInt('DB_PORT', 3306),
      user: process.env.DB_USERNAME ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_DATABASE ?? 'hubProjectDB',
      slowQueryThresholdMs: envInt('MONITOR_DB_SLOW_MS', 800),
    },
  ];
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
  mergeHubBackEnvFile();

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

  const mqttFromJson = parseJson(
    process.env.MONITOR_MQTT_BROKERS,
    [] as MonitorConfig['mqtt']['brokers'],
  );
  const mqttBrokers =
    mqttFromJson.length > 0 ? mqttFromJson : buildMqttFromHubEnv(serverId);

  const databasesFromJson = parseJson(
    process.env.MONITOR_DATABASES,
    [] as MonitorConfig['databases'],
  );
  const databases =
    databasesFromJson.length > 0 ? databasesFromJson : buildMysqlFromHubEnv(serverId);

  const redisInstances = parseJson(
    process.env.MONITOR_REDIS_INSTANCES,
    [] as MonitorConfig['redis']['instances'],
  );

  const queuesParsed = parseJson(process.env.MONITOR_QUEUES, [] as MonitorConfig['queues']);
  const queues = [...buildHubTelemetryQueueFromEnv(serverId), ...queuesParsed];

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
    hubWatch: buildHubWatchFromEnv(),
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
      recipients: envEmailRecipientsList('EMAIL_RECIPIENTS'),
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
      instantAlerts: {
        /** 기본 켜짐. 끄려면 MONITOR_INSTANT_ALERTS=false */
        enabled: process.env.MONITOR_INSTANT_ALERTS !== 'false',
        minSeverity: parseSeverityEnv('MONITOR_INSTANT_ALERT_MIN_SEVERITY', 'warning'),
        cooldownMs: envInt('MONITOR_INSTANT_ALERT_COOLDOWN_MS', 600_000),
        attachFullJson: process.env.MONITOR_INSTANT_ALERT_ATTACH_JSON !== 'false',
      },
    },
    store: {
      type: (process.env.STORE_TYPE as MonitorConfig['store']['type']) ?? 'sqlite',
      path: process.env.STORE_PATH ?? './data/monitor.db',
      ttlDays: envInt('STORE_TTL_DAYS', 30),
    },
  };
}
