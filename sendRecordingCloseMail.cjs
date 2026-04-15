'use strict';

/**
 * 녹음 CSV 종료 알림 메일 (허브 백엔드에서 require).
 *
 * 환경 변수:
 * - MONITOR_RECORDING_CLOSE_MAIL: 0|false 이면 발송 안 함 (허브 쪽에서도 차단 가능)
 * - MONITOR_RECORDING_CLOSE_TO: 수신자 이메일(쉼표). 없으면 NOTIFY_EMAIL
 * - MONITOR_MAIL_FROM: 없으면 SMTP user 또는 NOTIFY_EMAIL
 * - MONITOR_SMTP_HOST / MONITOR_SMTP_PORT: 설정 시 해당 호스트로 전송
 * - MONITOR_SMTP_SERVICE: 기본 gmail (호스트 미설정 시)
 * - MONITOR_SMTP_USER / MONITOR_SMTP_PASS: 없으면 NOTIFY_EMAIL / NOTIFY_EMAIL_PASS
 */

const path = require('path');

function loadNodemailer() {
  const candidates = [
    () => require('nodemailer'),
    () => require(path.join(__dirname, '../hub/hub_project/back/node_modules/nodemailer')),
  ];
  for (const fn of candidates) {
    try {
      return fn();
    } catch (_) {
      /* try next */
    }
  }
  throw new Error('nodemailer를 찾을 수 없습니다. hub/hub_project/back 에서 npm install 하세요.');
}

function buildTransporter(nm) {
  const user = process.env.MONITOR_SMTP_USER || process.env.NOTIFY_EMAIL;
  const pass = process.env.MONITOR_SMTP_PASS || process.env.NOTIFY_EMAIL_PASS;
  if (!user || !pass) {
    return { error: 'MONITOR_SMTP_USER/MONITOR_SMTP_PASS 또는 NOTIFY_EMAIL/NOTIFY_EMAIL_PASS 필요' };
  }
  const host = process.env.MONITOR_SMTP_HOST;
  const port = process.env.MONITOR_SMTP_PORT ? parseInt(process.env.MONITOR_SMTP_PORT, 10) : 587;
  if (host) {
    return {
      transporter: nm.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      }),
      user,
    };
  }
  return {
    transporter: nm.createTransport({
      service: process.env.MONITOR_SMTP_SERVICE || 'gmail',
      auth: { user, pass },
    }),
    user,
  };
}

/**
 * @param {{
 *   ownerEmail: string,
 *   hubMac: string,
 *   deviceMac: string,
 *   normalTermination: boolean,
 *   closeReason: string,
 *   mqttLogLines: string[],
 * }} p
 */
async function sendRecordingCloseMail(p) {
  const off = process.env.MONITOR_RECORDING_CLOSE_MAIL;
  if (off === '0' || off === 'false') return;

  const nm = loadNodemailer();
  const built = buildTransporter(nm);
  if (built.error) {
    console.warn('[monitor/sendRecordingCloseMail]', built.error);
    return;
  }
  const { transporter, user } = built;

  const toRaw = process.env.MONITOR_RECORDING_CLOSE_TO || process.env.NOTIFY_EMAIL;
  const recipients = String(toRaw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) {
    console.warn('[monitor/sendRecordingCloseMail] MONITOR_RECORDING_CLOSE_TO / NOTIFY_EMAIL 없음');
    return;
  }

  const { ownerEmail, hubMac, deviceMac, normalTermination, closeReason, mqttLogLines } = p;
  const line1 = ownerEmail;
  const line2 = `${hubMac}\t${deviceMac}`;
  const logBlock =
    Array.isArray(mqttLogLines) && mqttLogLines.length
      ? mqttLogLines.join('\n\n')
      : '(최근 hub → receive MQTT 발행 로그 없음)';

  const text = [
    line1,
    line2,
    '',
    logBlock,
    '',
    `closeReason: ${closeReason || ''}`,
    `종료 분류: ${normalTermination ? '정상 (lost_signal 수신 후 recording close)' : '비정상 (lost_signal 없이 recording close)'}`,
  ].join('\n');

  const subject = `[Talktail Hub] 녹음 ${normalTermination ? '정상' : '비정상'} 종료 | ${hubMac} | ${deviceMac}`;
  const from = process.env.MONITOR_MAIL_FROM || user;

  await transporter.sendMail({
    from,
    to: recipients.join(', '),
    subject,
    text,
  });
}

/**
 * 비정상: 측정·녹음 진행 중 연결 끊김 (lost_signal, 목록 제거, 텔레메트리 무음, LWT 등).
 * MONITOR_MEASURING_INTERRUPT_MAIL=0|false 로 끔.
 */
async function sendMeasuringInterruptMail(p) {
  const ioff = process.env.MONITOR_MEASURING_INTERRUPT_MAIL;
  if (ioff === '0' || ioff === 'false') return;
  if (p.classification === 'normal') return;

  const nm = loadNodemailer();
  const built = buildTransporter(nm);
  if (built.error) {
    console.warn('[monitor/sendMeasuringInterruptMail]', built.error);
    return;
  }
  const { transporter, user } = built;

  const toRaw = process.env.MONITOR_RECORDING_CLOSE_TO || process.env.NOTIFY_EMAIL;
  const recipients = String(toRaw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) {
    console.warn('[monitor/sendMeasuringInterruptMail] 수신자 없음');
    return;
  }

  const { ownerEmail, hubMac, deviceMac, trigger, detail, mqttLogLines } = p;
  const line1 = ownerEmail;
  const line2 = `${hubMac}\t${deviceMac}`;
  const logBlock =
    Array.isArray(mqttLogLines) && mqttLogLines.length
      ? mqttLogLines.join('\n\n')
      : '(최근 hub → receive MQTT 발행 로그 없음)';

  const text = [
    line1,
    line2,
    '',
    logBlock,
    '',
    '판단: 비정상 (측정 중이거나 녹음(recording)이 열린 상태에서 연결이 끊김)',
    '',
    `trigger: ${trigger || ''}`,
    detail ? `detail: ${detail}` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');

  const subject = `[Talktail Hub] 비정상: 측정·연결 끊김 | ${trigger || 'interrupt'} | ${hubMac}`;
  const from = process.env.MONITOR_MAIL_FROM || user;

  try {
    await transporter.sendMail({
      from,
      to: recipients.join(', '),
      subject,
      text,
    });
    console.log('[monitor/sendMeasuringInterruptMail] OK', subject);
  } catch (e) {
    console.error('[monitor/sendMeasuringInterruptMail] sendMail failed:', e?.message || e);
    throw e;
  }
}

module.exports = { sendRecordingCloseMail, sendMeasuringInterruptMail };
