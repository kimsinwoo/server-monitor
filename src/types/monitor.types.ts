export type Severity = 'critical' | 'error' | 'warning' | 'info';

export type Category =
  | 'http'
  | 'mqtt'
  | 'pm2'
  | 'system'
  | 'database'
  | 'docker'
  | 'ssl'
  | 'dns'
  | 'log'
  | 'redis'
  | 'queue'
  | 'frontend'
  | 'custom';

export interface SystemSnapshot {
  cpuPercent: number;
  ramUsedPercent: number;
  ramUsedMB: number;
  ramTotalMB: number;
  diskUsedPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  networkRxMBps: number;
  networkTxMBps: number;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
  uptime: number;
}

export interface MonitorEvent {
  id: string;
  timestamp: string;
  category: Category;
  severity: Severity;
  serverId: string;
  title: string;
  message: string;
  detail?: Record<string, unknown>;
  systemSnapshot: SystemSnapshot;
  resolved?: boolean;
  resolvedAt?: string;
  duration?: number;
}

export interface ServerConfig {
  id: string;
  name?: string;
}

export interface HttpEndpointConfig {
  serverId: string;
  url: string;
  method?: string;
  expectedStatus?: number;
  timeoutMs?: number;
  slowThresholdMs?: number;
  bodyCheck?: string;
}

export interface MqttBrokerConfig {
  serverId: string;
  url: string;
  clientId?: string;
  username?: string;
  password?: string;
  heartbeatTopic?: string;
  heartbeatTimeoutMs?: number;
}

export type DatabaseDriver = 'pg' | 'mysql' | 'mongoose' | 'better-sqlite3';

export interface DatabaseConfig {
  serverId: string;
  type: DatabaseDriver;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  slowQueryThresholdMs?: number;
  maxConnections?: number;
  lagThresholdMs?: number;
}

export interface RedisInstanceConfig {
  serverId: string;
  host: string;
  port?: number;
  password?: string;
  expectedSlaves?: number;
}

export interface QueueConfig {
  serverId: string;
  type: 'rabbitmq' | 'bull' | 'kafka';
  queueDepthThreshold?: number;
  connection?: Record<string, unknown>;
}

export interface MonitorConfig {
  timezone: string;
  collectIntervalMs: number;
  servers: ServerConfig[];
  thresholds: {
    cpu: { warning: number; critical: number };
    ram: { warning: number; critical: number };
    disk: { warning: number; critical: number };
    responseTime: { warning: number; critical: number };
  };
  http: { endpoints: HttpEndpointConfig[] };
  mqtt: { brokers: MqttBrokerConfig[] };
  databases: DatabaseConfig[];
  pm2: { enabled: boolean; memThresholdMB: number; cpuThresholdPercent: number };
  docker: { enabled: boolean; socketPath: string };
  ssl: { domains: string[]; warningDaysAhead: number; criticalDaysAhead: number };
  redis: { instances: RedisInstanceConfig[] };
  queues: QueueConfig[];
  logs: { files: string[]; patterns: string[]; errorRateThreshold?: number };
  frontend: { buildDir: string; healthUrls: string[]; bundleCompareDir?: string };
  dns: { checks: { serverId: string; hostname: string; expectedIps?: string[]; slowThresholdMs?: number }[] };
  email: {
    provider: 'smtp' | 'ses' | 'sendgrid' | 'resend';
    recipients: string[];
    from: string;
    smtp?: { host: string; port: number; user: string; pass: string };
    sesRegion?: string;
    sendgridApiKey?: string;
    resendApiKey?: string;
  };
  store: {
    type: 'sqlite' | 'json' | 'redis';
    path?: string;
    ttlDays: number;
  };
}

export interface EmailPayload {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
}

export interface EmailSender {
  send(payload: EmailPayload): Promise<void>;
}
