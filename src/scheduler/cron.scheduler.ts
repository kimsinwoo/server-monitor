import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { MonitorConfig } from '../types/monitor.types.js';
import type { EventStore } from '../aggregator/event.store.js';
import { ReportBuilder, getSeveritySummaryLine } from '../report/report.builder.js';
import type { EmailSender } from '../types/monitor.types.js';
import { sendWithBackoff } from '../mailer/email.sender.js';
import { injectPdfChromeStyles, renderHtmlToPdf } from '../mailer/html-to-pdf.js';
import { buildCompactDailyDigestEmailBody } from '../report/digest-email-compact.js';
import { buildDailyDigestSeverityText } from '../report/severity-attachment.js';
import { getYesterdayDateString } from '../utils/format.js';
import { formatUnknownError } from '../utils/error-serialize.js';
import { logger } from '../utils/logger.js';

export function startCronSchedulers(deps: {
  config: MonitorConfig;
  store: EventStore;
  reportBuilder: ReportBuilder;
  emailSender: EmailSender;
}): { stop: () => void } {
  const { config, store, reportBuilder, emailSender } = deps;
  const tz = config.timezone;

  const tasks: ScheduledTask[] = [];

  tasks.push(
    cron.schedule(
    '0 0 * * *',
    async () => {
      const yesterday = getYesterdayDateString(tz);
      try {
        const events = await store.getEventsForDate(yesterday);
        const summary = await store.getEventsSummary(yesterday);
        const fullHtml = await reportBuilder.build(events, yesterday, summary);
        if (!config.email.recipients.length) {
          logger.warn('daily digest skipped: EMAIL_RECIPIENTS 비어 있음');
          return;
        }

        const attachments: { filename: string; content: Buffer }[] = [];
        const errTxt = buildDailyDigestSeverityText(events, 'error');
        if (errTxt) {
          attachments.push({ filename: `daily-digest-${yesterday}-errors-and-critical.txt`, content: errTxt });
        }
        const warnTxt = buildDailyDigestSeverityText(events, 'warning');
        if (warnTxt) {
          attachments.push({ filename: `daily-digest-${yesterday}-warnings.txt`, content: warnTxt });
        }

        const pdfBuf = await renderHtmlToPdf(injectPdfChromeStyles(fullHtml));
        if (pdfBuf) {
          attachments.push({ filename: `daily-digest-${yesterday}.pdf`, content: pdfBuf });
        }

        const html =
          pdfBuf ? buildCompactDailyDigestEmailBody(yesterday, events, summary) : fullHtml;

        await sendWithBackoff(emailSender, {
          to: config.email.recipients,
          subject: `[서버 일간 리포트] ${yesterday} — ${getSeveritySummaryLine(events)}`,
          html,
          attachments: attachments.length ? attachments : undefined,
        });
      } catch (err) {
        logger.error('daily digest job failed', { error: formatUnknownError(err) });
      }
    },
    { timezone: tz },
    ),
  );

  tasks.push(
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
    ),
  );

  logger.info('cron schedulers started', { timezone: tz });

  return {
    stop: () => {
      for (const t of tasks) {
        try {
          t.stop();
        } catch (err) {
          logger.warn('cron task stop', { err: String(err) });
        }
      }
    },
  };
}
