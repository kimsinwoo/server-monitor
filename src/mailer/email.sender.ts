import nodemailer from 'nodemailer';
import type { EmailPayload, EmailSender, MonitorConfig } from '../types/monitor.types.js';
import { formatUnknownError } from '../utils/error-serialize.js';
import { logger } from '../utils/logger.js';

class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly from: string,
    private readonly transport: nodemailer.Transporter,
  ) {}

  async send(payload: EmailPayload): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: payload.to.length === 1 ? payload.to[0]! : payload.to,
      cc: payload.cc?.length ? (payload.cc.length === 1 ? payload.cc[0]! : payload.cc) : undefined,
      subject: payload.subject,
      html: payload.html,
      attachments: payload.attachments,
    });
  }
}

class StubEmailSender implements EmailSender {
  constructor(private readonly label: string) {}

  async send(payload: EmailPayload): Promise<void> {
    logger.warn('email sender stub', {
      label: this.label,
      to: payload.to,
      subject: payload.subject,
    });
  }
}

export function createEmailSender(cfg: MonitorConfig['email']): EmailSender {
  if (cfg.provider === 'smtp') {
    const smtp = cfg.smtp;
    if (!smtp?.host) {
      return new StubEmailSender('smtp-missing-host');
    }
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    return new SmtpEmailSender(cfg.from, transport);
  }
  if (cfg.provider === 'ses') {
    logger.warn('SES adapter not bundled; use SMTP or extend email.sender.ts');
    return new StubEmailSender('ses');
  }
  if (cfg.provider === 'sendgrid') {
    logger.warn('SendGrid adapter not bundled; use SMTP or extend email.sender.ts');
    return new StubEmailSender('sendgrid');
  }
  if (cfg.provider === 'resend') {
    logger.warn('Resend adapter not bundled; use SMTP or extend email.sender.ts');
    return new StubEmailSender('resend');
  }
  return new StubEmailSender('unknown');
}

export async function sendWithBackoff(sender: EmailSender, payload: EmailPayload): Promise<void> {
  const waitsBetweenAttempts = [0, 5 * 60_000, 15 * 60_000, 30 * 60_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = waitsBetweenAttempts[attempt] ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await sender.send(payload);
      logger.info('email sent', { subject: payload.subject });
      return;
    } catch (err) {
      lastErr = err;
      logger.error('email send failed', { attempt: attempt + 1, error: formatUnknownError(err) });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
