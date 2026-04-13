import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class FrontendCollector extends BaseCollector {
  readonly id = 'frontend';
  readonly category: Category = 'frontend';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    const serverId = this.config.servers[0]?.id ?? 'server-01';
    const buildDir = this.config.frontend.buildDir;

    if (buildDir) {
      try {
        const st = fs.statSync(buildDir);
        if (!st.isDirectory()) {
          const ev = await this.evaluate(true, {
            serverId,
            category: 'frontend',
            severity: 'critical',
            title: '프론트 빌드 디렉터리 없음',
            message: buildDir,
            detail: { buildDir },
          });
          if (ev) events.push(ev);
        } else {
          const indexHtml = path.join(buildDir, 'index.html');
          if (!fs.existsSync(indexHtml)) {
            const ev = await this.evaluate(true, {
              serverId,
              category: 'frontend',
              severity: 'error',
              title: 'index.html 누락',
              message: indexHtml,
              detail: { buildDir, file: 'index.html' },
            });
            if (ev) events.push(ev);
          }
        }
      } catch {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'frontend',
          severity: 'critical',
          title: '프론트 빌드 경로 접근 실패',
          message: buildDir,
          detail: { buildDir },
        });
        if (ev) events.push(ev);
      }
    }

    for (const url of this.config.frontend.healthUrls) {
      try {
        const res = await axios.get(url, { timeout: 10_000, validateStatus: () => true });
        if (res.status === 404) {
          const ev = await this.evaluate(true, {
            serverId,
            category: 'frontend',
            severity: 'error',
            title: '프론트 헬스 404',
            message: url,
            detail: { url, statusCode: res.status },
          });
          if (ev) events.push(ev);
        }
      } catch (err) {
        const ev = await this.evaluate(true, {
          serverId,
          category: 'frontend',
          severity: 'error',
          title: '프론트 헬스 요청 실패',
          message: `${url}: ${err instanceof Error ? err.message : String(err)}`,
          detail: { url },
        });
        if (ev) events.push(ev);
      }
    }

    return events;
  }
}
