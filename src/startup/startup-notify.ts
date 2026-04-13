import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import axios from 'axios';
import type { MonitorConfig } from '../types/monitor.types.js';
import type { EmailSender } from '../types/monitor.types.js';
import type { EventStore } from '../aggregator/event.store.js';
import { captureSystemSnapshot } from '../utils/system-snapshot.js';
import { logger } from '../utils/logger.js';

export type StartupCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function push(checks: StartupCheck[], id: string, label: string, ok: boolean, detail: string): void {
  checks.push({ id, label, ok, detail });
}

export async function runStartupAudit(config: MonitorConfig, store: EventStore): Promise<StartupCheck[]> {
  const checks: StartupCheck[] = [];
  const host = os.hostname();
  push(checks, 'host', '호스트명', true, host);

  if (!config.email.recipients.length) {
    push(checks, 'recipients', '이메일 수신자', false, 'EMAIL_RECIPIENTS 비어 있음 — 기동 알림·일간 리포트 미발송');
  } else {
    push(checks, 'recipients', '이메일 수신자', true, config.email.recipients.join(', '));
  }

  try {
    await store.getEventsForDate('2000-01-01');
    push(checks, 'store', '이벤트 저장소', true, `${config.store.type} ${config.store.path ?? ''}`.trim());
  } catch (e) {
    push(checks, 'store', '이벤트 저장소', false, e instanceof Error ? e.message : String(e));
  }

  try {
    const snap = await withTimeout(captureSystemSnapshot(), 20_000, 'system snapshot');
    push(
      checks,
      'system',
      '시스템 스냅샷',
      true,
      `CPU ${snap.cpuPercent.toFixed(0)}% · RAM ${snap.ramUsedPercent.toFixed(0)}% · Disk ${snap.diskUsedPercent.toFixed(0)}% · load ${snap.loadAvg1m.toFixed(2)}`,
    );
  } catch (e) {
    push(checks, 'system', '시스템 스냅샷', false, e instanceof Error ? e.message : String(e));
  }

  for (const ep of config.http.endpoints) {
    const method = (ep.method ?? 'GET').toUpperCase();
    const url = ep.url;
    const tag = `http:${url}`;
    try {
      const res = await withTimeout(
        axios.request({ url, method: method as 'GET', timeout: ep.timeoutMs ?? 12_000, validateStatus: () => true }),
        (ep.timeoutMs ?? 12_000) + 2000,
        tag,
      );
      const expected = ep.expectedStatus ?? 200;
      if (res.status === expected) {
        push(checks, tag, `HTTP ${method} ${url}`, true, `status ${res.status}`);
      } else {
        push(checks, tag, `HTTP ${method} ${url}`, false, `기대 ${expected}, 실제 ${res.status}`);
      }
    } catch (e) {
      push(checks, tag, `HTTP ${method} ${url}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  if (config.http.endpoints.length === 0) {
    push(checks, 'http-none', 'HTTP 엔드포인트', true, '설정 없음 (MONITOR_HUB_* 또는 MONITOR_HTTP_ENDPOINTS)');
  }

  if (config.pm2.enabled) {
    try {
      const require = createRequire(import.meta.url);
      const pm2 = require('pm2') as {
        connect: (cb: (err: Error | null) => void) => void;
        list: (cb: (err: Error | null, res: unknown[]) => void) => void;
        disconnect: () => void;
      };
      const list = await new Promise<unknown[]>((resolve, reject) => {
        pm2.connect((err: Error | null) => {
          if (err) return reject(err);
          pm2.list((e, res) => {
            pm2.disconnect();
            if (e) reject(e);
            else resolve(res ?? []);
          });
        });
      });
      push(checks, 'pm2', 'PM2 프로세스', true, `${list.length}개 등록`);
    } catch (e) {
      push(checks, 'pm2', 'PM2 프로세스', false, e instanceof Error ? e.message : String(e));
    }
  } else {
    push(checks, 'pm2', 'PM2', true, '비활성 (MONITOR_PM2_ENABLED!=true)');
  }

  if (config.docker.enabled) {
    try {
      const Dockerode = (await import('dockerode')).default;
      const docker = new Dockerode({ socketPath: config.docker.socketPath });
      const list = await withTimeout(docker.listContainers({ limit: 5 }), 8000, 'docker');
      push(checks, 'docker', 'Docker', true, `데몬 응답 · 샘플 ${list.length}개 컨테이너`);
    } catch (e) {
      push(checks, 'docker', 'Docker', false, e instanceof Error ? e.message : String(e));
    }
  } else {
    push(checks, 'docker', 'Docker', true, '비활성');
  }

  const mqttLib = config.mqtt.brokers.length > 0 ? (await import('mqtt')).default : null;
  for (let i = 0; i < config.mqtt.brokers.length; i++) {
    const b = config.mqtt.brokers[i]!;
    const tag = `mqtt-${i}`;
    try {
      if (!mqttLib) break;
      const clientId = b.clientId ?? `monitor-startup-${Date.now()}`;
      const timeoutMs = Math.min(b.heartbeatTimeoutMs ?? 8000, 8000);
      await new Promise<void>((resolve, reject) => {
        const client = mqttLib.connect(b.url, {
          clientId,
          username: b.username,
          password: b.password,
          connectTimeout: timeoutMs,
        });
        const t = setTimeout(() => {
          client.end(true);
          reject(new Error('timeout'));
        }, timeoutMs);
        client.on('connect', () => {
          clearTimeout(t);
          client.end(true);
          resolve();
        });
        client.on('error', (err) => {
          clearTimeout(t);
          client.end(true);
          reject(err);
        });
      });
      push(checks, tag, `MQTT 브로커 ${i + 1}`, true, b.url.replace(/:[^:@/]+@/, ':***@'));
    } catch (e) {
      push(checks, tag, `MQTT 브로커 ${i + 1}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  if (config.mqtt.brokers.length === 0) {
    push(checks, 'mqtt-none', 'MQTT', true, '브로커 설정 없음');
  }

  if (config.redis.instances.length > 0) {
    const { Redis } = await import('ioredis');
    for (let i = 0; i < config.redis.instances.length; i++) {
      const inst = config.redis.instances[i]!;
      const tag = `redis-${i}`;
      const client = new Redis({
        host: inst.host,
        port: inst.port ?? 6379,
        password: inst.password,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
      });
      try {
        await withTimeout(client.ping(), 6000, tag);
        await client.quit();
        push(checks, tag, `Redis ${inst.host}`, true, 'PING OK');
      } catch (e) {
        try {
          client.disconnect();
        } catch {
          /* ignore */
        }
        push(checks, tag, `Redis ${inst.host}`, false, e instanceof Error ? e.message : String(e));
      }
    }
  } else {
    push(checks, 'redis-none', 'Redis', true, '인스턴스 설정 없음');
  }

  for (let i = 0; i < config.databases.length; i++) {
    const db = config.databases[i]!;
    const tag = `db-${i}`;
    if (db.type === 'mongoose') {
      push(checks, tag, `DB ${db.type}`, true, '수집기 미구현 — 점검 생략');
      continue;
    }
    try {
      if (db.type === 'pg') {
        const { Client } = await import('pg');
        const client = new Client({ connectionString: db.connectionString });
        await withTimeout(
          (async () => {
            await client.connect();
            await client.query('SELECT 1');
            await client.end();
          })(),
          8000,
          tag,
        );
        push(checks, tag, `PostgreSQL`, true, '연결·쿼리 OK');
      } else if (db.type === 'mysql') {
        const mysql = await import('mysql2/promise');
        const conn = await mysql.createConnection({
          host: db.host,
          port: db.port,
          user: db.user,
          password: db.password,
          database: db.database,
        });
        await withTimeout(conn.query('SELECT 1'), 8000, tag);
        await conn.end();
        push(checks, tag, `MySQL`, true, '연결·쿼리 OK');
      } else if (db.type === 'better-sqlite3') {
        const Database = (await import('better-sqlite3')).default;
        const p = db.connectionString ?? db.database ?? ':memory:';
        const sql = new Database(p);
        sql.prepare('SELECT 1').get();
        sql.close();
        push(checks, tag, `SQLite`, true, path.basename(p));
      }
    } catch (e) {
      push(checks, tag, `DB ${db.type}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  if (config.databases.length === 0) {
    push(checks, 'db-none', '데이터베이스', true, '설정 없음');
  }

  for (let i = 0; i < config.dns.checks.length; i++) {
    const c = config.dns.checks[i]!;
    const tag = `dns-${i}`;
    try {
      const started = Date.now();
      const r = await withTimeout(dns.lookup(c.hostname, { all: true }), 8000, tag);
      const ms = Date.now() - started;
      push(checks, tag, `DNS ${c.hostname}`, true, `${r.map((x) => x.address).join(', ')} (${ms}ms)`);
    } catch (e) {
      push(checks, tag, `DNS ${c.hostname}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  if (config.dns.checks.length === 0) {
    push(checks, 'dns-none', 'DNS', true, '검사 항목 없음');
  }

  for (let i = 0; i < config.ssl.domains.length; i++) {
    const domain = config.ssl.domains[i]!;
    const tag = `ssl-${i}`;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let to: ReturnType<typeof setTimeout>;
        const socket = tls.connect(
          { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
          () => {
            if (!settled) {
              settled = true;
              clearTimeout(to);
              socket.end();
              resolve();
            }
          },
        );
        to = setTimeout(() => {
          if (!settled) {
            settled = true;
            socket.destroy();
            reject(new Error('TLS timeout'));
          }
        }, 8000);
        socket.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(to);
            reject(err);
          }
        });
      });
      push(checks, tag, `SSL ${domain}`, true, 'TLS 443 응답');
    } catch (e) {
      push(checks, tag, `SSL ${domain}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  if (config.ssl.domains.length === 0) {
    push(checks, 'ssl-none', 'SSL 인증서', true, '도메인 설정 없음');
  }

  for (const f of config.logs.files) {
    const tag = `log:${f}`;
    const short = path.basename(f);
    try {
      fs.accessSync(f, fs.constants.R_OK);
      push(checks, tag, `로그 읽기 (${short})`, true, f);
    } catch {
      push(checks, tag, `로그 읽기 (${short})`, false, `읽기 불가 또는 없음: ${f}`);
    }
  }
  if (config.logs.files.length === 0) {
    push(checks, 'log-none', '로그 파일 감시', true, '경로 설정 없음');
  }

  if (config.frontend.buildDir) {
    try {
      const st = fs.statSync(config.frontend.buildDir);
      const indexHtml = path.join(config.frontend.buildDir, 'index.html');
      const hasIndex = fs.existsSync(indexHtml);
      push(
        checks,
        'frontend-dist',
        '프론트 빌드 디렉터리',
        st.isDirectory() && hasIndex,
        hasIndex ? config.frontend.buildDir : `${config.frontend.buildDir} (index.html 없음)`,
      );
    } catch {
      push(checks, 'frontend-dist', '프론트 빌드 디렉터리', false, config.frontend.buildDir);
    }
  } else {
    push(checks, 'frontend-dist', '프론트 빌드', true, 'MONITOR_FRONTEND_BUILD_DIR 미설정');
  }

  for (let i = 0; i < config.frontend.healthUrls.length; i++) {
    const url = config.frontend.healthUrls[i]!;
    const tag = `fe-url-${i}`;
    try {
      const res = await withTimeout(axios.get(url, { timeout: 10_000, validateStatus: () => true }), 12_000, tag);
      push(checks, tag, `프론트 URL`, res.status < 400, `${url} → ${res.status}`);
    } catch (e) {
      push(checks, tag, `프론트 URL`, false, `${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const hubTelemetryQueues = config.queues.filter((q) => q.type === 'hub-telemetry');
  if (hubTelemetryQueues.length === 0) {
    push(checks, 'queue', '메시지 큐(허브 텔레메트리)', true, 'hub-telemetry 미구성 · MONITOR_HUB_* 또는 MONITOR_HUB_QUEUE_METRICS_URL');
  } else {
    for (let i = 0; i < hubTelemetryQueues.length; i++) {
      const q = hubTelemetryQueues[i]!;
      const c = q.connection as { url?: string; token?: string };
      const tag = `queue-hub-${i}`;
      if (!c?.url) {
        push(checks, tag, '허브 텔레메트리 큐', false, 'connection.url 없음');
        continue;
      }
      try {
        const headers: Record<string, string> = {};
        if (c.token) headers['X-Monitor-Token'] = c.token;
        const res = await withTimeout(
          axios.get(c.url, { timeout: 8000, validateStatus: () => true, headers }),
          10_000,
          tag,
        );
        if (res.status !== 200) {
          push(checks, tag, '허브 텔레메트리 큐', false, `HTTP ${res.status}`);
          continue;
        }
        const body = res.data as { telemetryQueueLength?: number; workerRunning?: boolean };
        const len = body.telemetryQueueLength ?? 0;
        const ok = body.workerRunning !== false || len === 0;
        push(
          checks,
          tag,
          '허브 텔레메트리 큐',
          ok,
          `대기 ${len}건 · workerRunning=${String(body.workerRunning)}`,
        );
      } catch (e) {
        push(checks, tag, '허브 텔레메트리 큐', false, e instanceof Error ? e.message : String(e));
      }
    }
  }
  push(checks, 'cron', '스케줄러', true, '일간 리포트 0:00 · TTL 정리 1:00 (node-cron)');

  if (config.email.provider === 'smtp' && config.email.smtp?.host) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const smtp = config.email.smtp;
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      });
      await withTimeout(transport.verify(), 15_000, 'smtp-verify');
      push(checks, 'smtp-verify', 'SMTP 연결 검증', true, `${smtp.host}:${smtp.port}`);
    } catch (e) {
      push(checks, 'smtp-verify', 'SMTP 연결 검증', false, e instanceof Error ? e.message : String(e));
    }
  } else {
    push(checks, 'smtp-verify', 'SMTP', true, '스텁 또는 비SMTP — verify 생략');
  }

  return checks;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildStartupEmailHtml(checks: StartupCheck[], startedAtIso: string): string {
  const failed = checks.filter((c) => !c.ok).length;
  const ok = checks.length - failed;
  const summary =
    failed === 0
      ? `전체 ${checks.length}항목 정상`
      : `정상 ${ok} / 이상 ${failed} (아래 빨간 행 확인)`;

  const rows = checks
    .map((c) => {
      const style = c.ok
        ? 'background:#ecfdf5;color:#065f46;'
        : 'background:#fee2e2;color:#991b1b;';
      return `<tr style="${style}"><td style="padding:8px;font-size:13px;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(c.label)}</td><td style="padding:8px;font-size:13px;font-family:Arial,Helvetica,sans-serif;">${c.ok ? '정상' : '주의'}</td><td style="padding:8px;font-size:12px;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(c.detail)}</td></tr>`;
    })
    .join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:16px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;" cellpadding="0" cellspacing="0" width="100%">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
<h1 style="margin:0;font-size:18px;color:#111827;">일간 모니터 기동 완료</h1>
<p style="margin:8px 0 0;font-size:13px;color:#6b7280;">시각: ${escapeHtml(startedAtIso)}</p>
<p style="margin:8px 0 0;font-size:14px;color:#374151;"><strong>요약:</strong> ${escapeHtml(summary)}</p>
</td></tr>
<tr><td style="padding:16px 24px;">
<p style="margin:0 0 12px;font-size:13px;color:#374151;">프로세스가 시작되었으며, 아래는 기동 시점 기능 점검 결과입니다.</p>
<table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
<tr style="background:#f3f4f6;color:#111827;font-size:12px;"><th align="left">항목</th><th align="left">결과</th><th align="left">내용</th></tr>
${rows}
</table>
</td></tr>
</table></body></html>`;
}

export async function sendStartupReportIfConfigured(params: {
  config: MonitorConfig;
  store: EventStore;
  emailSender: EmailSender;
}): Promise<void> {
  const { config, store, emailSender } = params;

  if (process.env.MONITOR_STARTUP_EMAIL === 'false') {
    logger.info('startup email skipped (MONITOR_STARTUP_EMAIL=false)');
    return;
  }

  if (!config.email.recipients.length) {
    logger.warn('startup email skipped: no EMAIL_RECIPIENTS');
    return;
  }

  const startedAt = new Date().toISOString();
  let checks: StartupCheck[] = [];
  try {
    checks = await runStartupAudit(config, store);
  } catch (e) {
    logger.error('startup audit failed', { error: String(e) });
    checks = [
      {
        id: 'audit-fatal',
        label: '점검 실행',
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      },
    ];
  }

  const html = buildStartupEmailHtml(checks, startedAt);
  const failed = checks.filter((c) => !c.ok).length;

  try {
    await emailSender.send({
      to: config.email.recipients,
      subject: `[일간 모니터] 기동 완료 · 점검 ${failed === 0 ? '전체 정상' : `이상 ${failed}건`} (${os.hostname()})`,
      html,
    });
    logger.info('startup notification email sent', { recipients: config.email.recipients.length });
  } catch (e) {
    logger.error('startup notification email failed', { error: String(e) });
  }
}
