import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';
import { logger } from '../utils/logger.js';

export class DockerCollector extends BaseCollector {
  readonly id = 'docker';
  readonly category: Category = 'docker';
  readonly intervalMs: number;
  private lastRestartMap = new Map<string, number>();

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    if (!this.config.docker.enabled) return [];
    const events: MonitorEvent[] = [];
    try {
      const Dockerode = (await import('dockerode')).default;
      const docker = new Dockerode({ socketPath: this.config.docker.socketPath });
      const containers = await docker.listContainers({ all: true });

      for (const c of containers) {
        const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
        const state = c.State ?? '';
        let restartCount = 0;
        try {
          const inspect = await docker.getContainer(c.Id).inspect();
          restartCount = inspect.RestartCount ?? 0;
        } catch {
          restartCount = 0;
        }
        const statusText = c.Status ?? '';
        const detail = {
          containerName: name,
          containerId: c.Id,
          status: state,
          restartCount,
          exitCode: statusText,
        };

        if (state !== 'running') {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'docker',
            severity: 'critical',
            title: 'Docker 컨테이너 비정상',
            message: `${name} 상태 ${state}`,
            detail,
          });
          if (ev) events.push(ev);
        }

        const prev = this.lastRestartMap.get(c.Id);
        if (prev !== undefined && restartCount > prev) {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'docker',
            severity: 'error',
            title: 'Docker 재시작 증가',
            message: `${name} restart ${prev} → ${restartCount}`,
            detail,
          });
          if (ev) events.push(ev);
        }
        this.lastRestartMap.set(c.Id, restartCount);

        if (statusText.toLowerCase().includes('oom')) {
          const ev = await this.evaluate(true, {
            serverId: this.config.servers[0]?.id ?? 'server-01',
            category: 'docker',
            severity: 'critical',
            title: 'Docker OOM',
            message: name,
            detail,
          });
          if (ev) events.push(ev);
        }
      }
    } catch (err) {
      logger.warn('docker collector skipped', { error: String(err) });
    }
    return events;
  }
}
