import cron from 'node-cron';
import type { MonitorConfig } from '../types/monitor.types.js';
import type { EventStore } from '../aggregator/event.store.js';
import { ReportBuilder, getSeveritySummaryLine } from '../report/report.builder.js';
import type { EmailSender } from '../types/monitor.types.js';
import { sendWithBackoff } from '../mailer/email.sender.js';
import { getYesterdayDateString } from '../utils/format.js';
import { logger } from '../utils/logger.js';

export function startCronSchedulers(deps: {
  config: MonitorConfig;
  store: EventStore;
  reportBuilder: ReportBuilder;
  emailSender: EmailSender;
}): void {
  const { config, store, reportBuilder, emailSender } = deps;
  const tz = config.timezone;

  cron.schedule(
    '0 0 * * *',
    async () => {
      const yesterday = getYesterdayDateString(tz);
      try {
        const events = await store.getEventsForDate(yesterday);
        const summary = await store.getEventsSummary(yesterday);
        const html = await reportBuilder.build(events, yesterday, summary);
        if (!config.email.recipients.length) {
          logger.warn('daily digest skipped: EMAIL_RECIPIENTS 비어 있음');
          return;
        }
        await sendWithBackoff(emailSender, {
          to: config.email.recipients,
          subject: `[서버 일간 리포트] ${yesterday} — ${getSeveritySummaryLine(events)}`,
          html,
        });
      } catch (err) {
        logger.error('daily digest job failed', { error: String(err) });
      }
    },
    { timezone: tz },
  );

  cron.schedule(
    '0 1 * * *',
    () => {
      try {
        store.purgeOlderThanDays(config.store.ttlDays);
        logger.info('event store TTL purge done', { ttlDays: config.store.ttlDays });
      } catch (err) {
        logger.error('TTL purge failed', { error: String(err) });
      }
    },
    { timezone: tz },
  );

  logger.info('cron schedulers started', { timezone: tz });
}
