import { randomUUID } from 'node:crypto';
import type { Category, MonitorEvent, SystemSnapshot } from '../types/monitor.types.js';
import { captureSystemSnapshot } from '../utils/system-snapshot.js';

export abstract class BaseCollector {
  abstract readonly id: string;
  abstract readonly category: Category;
  abstract readonly intervalMs: number;

  abstract collect(): Promise<MonitorEvent[]>;

  protected buildEvent(
    snapshot: SystemSnapshot,
    event: Omit<MonitorEvent, 'id' | 'timestamp' | 'systemSnapshot'>,
  ): MonitorEvent {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      systemSnapshot: snapshot,
      ...event,
    };
  }

  protected async evaluate(
    condition: boolean,
    event: Omit<MonitorEvent, 'id' | 'timestamp' | 'systemSnapshot'>,
  ): Promise<MonitorEvent | null> {
    if (!condition) return null;
    const snapshot = await captureSystemSnapshot();
    return this.buildEvent(snapshot, event);
  }
}
