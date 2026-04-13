import fs from 'node:fs';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class LogCollector extends BaseCollector {
  readonly id = 'log';
  readonly category: Category = 'log';
  readonly intervalMs: number;
  private fileOffsets = new Map<string, number>();

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    const patterns = this.config.logs.patterns;
    const serverId = this.config.servers[0]?.id ?? 'server-01';

    for (const logFile of this.config.logs.files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(logFile);
      } catch {
        continue;
      }
      const prev = this.fileOffsets.get(logFile) ?? 0;
      if (stat.size < prev) {
        this.fileOffsets.set(logFile, 0);
      }
      const start = Math.min(prev, stat.size);
      const fd = fs.openSync(logFile, 'r');
      const toRead = stat.size - start;
      let chunk = '';
      if (toRead > 0) {
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, start);
        chunk = buf.toString('utf8');
      }
      fs.closeSync(fd);
      this.fileOffsets.set(logFile, stat.size);

      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const upper = line.toUpperCase();
        const matched = patterns.find((p) => upper.includes(p.toUpperCase()));
        if (!matched) continue;

        let severity: MonitorEvent['severity'] = 'error';
        if (upper.includes('CRITICAL') || upper.includes('FATAL')) severity = 'critical';
        else if (upper.includes('WARNING') || upper.includes('WARN')) severity = 'warning';

        const stackLike = /^\s+at\s+/m.test(line) || line.includes('Error:');
        if (stackLike && severity === 'warning') severity = 'error';

        const ev = await this.evaluate(true, {
          serverId,
          category: 'log',
          severity,
          title: `로그 ${matched} 감지`,
          message: line.slice(0, 500),
          detail: {
            logFile,
            matchedLine: line.slice(0, 2000),
            errorCount1m: 1,
            pattern: matched,
          },
        });
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}
