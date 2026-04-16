import type { MonitorConfig, MonitorEvent } from '../types/monitor.types.js';
import type { EmailSender } from '../types/monitor.types.js';
import { sendWithBackoff } from '../mailer/email.sender.js';
import { formatUnknownError } from '../utils/error-serialize.js';
import { analyzeMonitorEvent, meetsMinSeverity } from '../report/event-analysis.js';
import { buildInstantAlertPayload } from '../report/instant-alert.builder.js';
import { logger } from '../utils/logger.js';

function cooldownKey(e: MonitorEvent): string {
  const title = String(e.title || '').slice(0, 200);
  return `${e.serverId}\t${e.category}\t${title}`;
}

export class InstantAlertDispatcher {
  private static readonly MAX_COOLDOWN_ENTRIES = 5000;
  /** 키별 마지막 발송 시각이 이 시간보다 오래되면 제거 (Map 무한 증가 방지) */
  private static readonly COOLDOWN_ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  private readonly lastSentMs = new Map<string, number>();

  constructor(
    private readonly config: MonitorConfig,
    private readonly emailSender: EmailSender,
  ) {}

  /** 오래된 쿨다운 키 제거 + 상한 초과 시 가장 오래된 항목부터 삭제 */
  private pruneCooldownMap(now: number, cooldownMs: number): void {
    const maxAge = Math.max(
      InstantAlertDispatcher.COOLDOWN_ENTRY_MAX_AGE_MS,
      cooldownMs * 200,
    );
    for (const [k, t] of this.lastSentMs) {
      if (now - t > maxAge) this.lastSentMs.delete(k);
    }
    while (this.lastSentMs.size > InstantAlertDispatcher.MAX_COOLDOWN_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestT = Infinity;
      for (const [k, t] of this.lastSentMs) {
        if (t < oldestT) {
          oldestT = t;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.lastSentMs.delete(oldestKey);
    }
  }

  /** 수집기 루프를 막지 않도록 비동기로 처리 */
  notifyNewEvents(events: MonitorEvent[]): void {
    if (!events.length) return;
    const ia = this.config.email.instantAlerts;
    if (!ia?.enabled) return;
    void this.run(events, ia).catch((err) => {
      logger.error('instant alert batch failed', { error: formatUnknownError(err) });
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

    const now = Date.now();
    this.pruneCooldownMap(now, ia.cooldownMs);

    for (const e of events) {
      if (!meetsMinSeverity(e.severity, ia.minSeverity)) continue;

      const key = cooldownKey(e);
      const prev = this.lastSentMs.get(key) ?? 0;
      if (now - prev < ia.cooldownMs) {
        continue;
      }

      this.lastSentMs.set(key, now);
      try {
        const analysis = analyzeMonitorEvent(e);
        const payload = await buildInstantAlertPayload(e, analysis, ia.attachFullJson, recipients);
        await sendWithBackoff(this.emailSender, payload);
        logger.info('instant alert email sent', { eventId: e.id, severity: e.severity, category: e.category });
      } catch (err) {
        this.lastSentMs.delete(key);
        logger.error('instant alert send failed', { eventId: e.id, error: formatUnknownError(err) });
      }
    }
  }
}
