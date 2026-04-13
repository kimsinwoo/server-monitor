import type { BaseCollector } from '../collectors/base.collector.js';
import { EventStore } from './event.store.js';
import { logger } from '../utils/logger.js';

export class EventAggregator {
  constructor(private readonly store: EventStore) {}

  async runCollector(collector: BaseCollector): Promise<void> {
    try {
      const events = await collector.collect();
      for (const e of events) {
        await this.store.appendEvent(e);
      }
      if (events.length) {
        logger.info('collector events', { id: collector.id, count: events.length });
      }
    } catch (err) {
      logger.error('collector failed', { id: collector.id, error: String(err) });
    }
  }
}
