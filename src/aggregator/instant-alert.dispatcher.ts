import type { MonitorConfig, MonitorEvent } from '../types/monitor.types.js';
import type { EmailSender } from '../types/monitor.types.js';
import { sendWithBackoff } from '../mailer/email.sender.js';
import { analyzeMonitorEvent, meetsMinSeverity } from '../report/event-analysis.js';
import { buildInstantAlertPayload } from '../report/instant-alert.builder.js';
import { logger } from '../utils/logger.js';

function cooldownKey(e: MonitorEvent): string {
  const title = String(e.title || '').slice(0, 200);
  return `${e.serverId}\t${e.category}\t${title}`;
}

export class InstantAlertDispatcher {
  private readonly lastSentMs = new Map<string, number>();

  constructor(
    private readonly config: MonitorConfig,
    private readonly emailSender: EmailSender,
  ) {}

  /** 수집기 루프를 막지 않도록 비동기로 처리 */
  notifyNewEvents(events: MonitorEvent[]): void {
    if (!events.length) return;
    const ia = this.config.email.instantAlerts;
    if (!ia?.enabled) return;
    void this.run(events, ia).catch((err) => {
      logger.error('instant alert batch failed', { error: String(err) });
    });
  }

  private async run(
    events: MonitorEvent[],
    ia: NonNullable<MonitorConfig['email']['instantAlerts']>,
  ): Promise<void> {
    const recipients = this.config.email.recipients;
    if (!recipients.length) {
      logger.warn('instant alert skipped: EMAIL_RECIPIENTS empty');
      return;
    }

    for (const e of events) {
      if (!meetsMinSeverity(e.severity, ia.minSeverity)) continue;

      const key = cooldownKey(e);
      const now = Date.now();
      const prev = this.lastSentMs.get(key) ?? 0;
      if (now - prev < ia.cooldownMs) {
        continue;
      }

      this.lastSentMs.set(key, now);
      try {
        const analysis = analyzeMonitorEvent(e);
        const payload = buildInstantAlertPayload(e, analysis, ia.attachFullJson, recipients);
        await sendWithBackoff(this.emailSender, payload);
        logger.info('instant alert email sent', { eventId: e.id, severity: e.severity, category: e.category });
      } catch (err) {
        this.lastSentMs.delete(key);
        logger.error('instant alert send failed', { eventId: e.id, error: String(err) });
      }
    }
  }
}
