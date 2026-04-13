import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class QueueCollector extends BaseCollector {
  readonly id = 'queue';
  readonly category: Category = 'queue';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    void this.config.queues;
    return [];
  }
}
