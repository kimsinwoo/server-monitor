import type { MonitorEvent } from '../types/monitor.types.js';
import type { EmailPayload } from '../types/monitor.types.js';
import { injectPdfChromeStyles, renderHtmlToPdf } from '../mailer/html-to-pdf.js';
import { analysisToHtmlList } from './event-analysis.js';
import { buildInstantSeverityAttachments } from './severity-attachment.js';

const FF = 'Helvetica Neue,Helvetica,Arial,sans-serif';
const BODY_MSG_MAX = 8000;
const BODY_DETAIL_JSON_MAX = 12000;
const PDF_BODY_MAX = 1_000_000;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatDetailJson(detail?: Record<string, unknown>): string | null {
  if (!detail || Object.keys(detail).length === 0) return null;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return null;
  }
}

function snapshotBlock(e: MonitorEvent): string {
  const s = e.systemSnapshot;
  const ramMeta =
    s.ramMethod === 'linux_proc_memavailable'
      ? 'MemAvailable'
      : s.ramMethod === 'darwin_vmstat'
        ? 'vm_stat'
        : s.ramMethod ?? '—';
  const rows: [string, string][] = [
    ['CPU 사용률', `${s.cpuPercent.toFixed(1)}%`],
    ['RAM 사용률', `${s.ramUsedPercent.toFixed(1)}% (${s.ramUsedMB.toFixed(0)} / ${s.ramTotalMB.toFixed(0)} MB)`],
    ['RAM 산출', ramMeta],
    ['디스크 사용률', `${s.diskUsedPercent.toFixed(1)}% (${s.diskUsedGB.toFixed(1)} / ${s.diskTotalGB.toFixed(1)} GB)`],
    ['부하 평균 1/5/15m', `${s.loadAvg1m.toFixed(2)} / ${s.loadAvg5m.toFixed(2)} / ${s.loadAvg15m.toFixed(2)}`],
    ['네트워크 Rx/Tx', `${s.networkRxMBps.toFixed(3)} / ${s.networkTxMBps.toFixed(3)} MB/s`],
    ['업타임(초)', String(Math.floor(s.uptime))],
  ];
  if (s.ramAvailableMB != null) {
    rows.splice(3, 0, ['추정 가용 RAM(MB)', String(s.ramAvailableMB.toFixed(0))]);
  }
  const tr = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 12px;border:1px solid #e8e8ed;font-size:12px;color:#6e6e73;font-family:${FF};width:38%;">${esc(k)}</td><td style="padding:8px 12px;border:1px solid #e8e8ed;font-size:12px;color:#1d1d1f;font-family:${FF};word-break:break-word;">${esc(v)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:10px;">${tr}</table>`;
}

function severityColor(sev: MonitorEvent['severity']): { bg: string; fg: string; label: string } {
  switch (sev) {
    case 'critical':
      return { bg: '#fff2f2', fg: '#991b1b', label: 'CRITICAL' };
    case 'error':
      return { bg: '#fef3c7', fg: '#92400e', label: 'ERROR' };
    case 'warning':
      return { bg: '#eff6ff', fg: '#1e40af', label: 'WARNING' };
    default:
      return { bg: '#f0f7ff', fg: '#0071e3', label: 'INFO' };
  }
}

function buildInstantFullHtml(
  event: MonitorEvent,
  analysisText: string,
  limits: { bodyMsgMax: number; bodyDetailJsonMax: number },
): string {
  const { bg, fg, label } = severityColor(event.severity);
  const detailJson = formatDetailJson(event.detail);
  const detailInBody = detailJson ? trunc(detailJson, limits.bodyDetailJsonMax) : '';
  const analysisHtml = analysisToHtmlList(analysisText);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#f5f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;border:1px solid #e8e8ed;">
<tr><td style="padding:20px 22px 8px;font-family:${FF};">
  <span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:0.8px;padding:6px 14px;border-radius:100px;">${label}</span>
  <h1 style="margin:14px 0 0;font-size:18px;font-weight:600;color:#1d1d1f;line-height:1.35;">${esc(event.title)}</h1>
  <p style="margin:8px 0 0;font-size:12px;color:#6e6e73;">이벤트 ID <code style="background:#f5f5f7;padding:2px 6px;border-radius:4px;">${esc(event.id)}</code> · ${esc(event.timestamp)}</p>
</td></tr>
<tr><td style="padding:8px 22px;font-family:${FF};font-size:13px;color:#1d1d1f;">
  <p style="margin:0 0 6px;"><strong>서버</strong> ${esc(event.serverId)} · <strong>카테고리</strong> ${esc(event.category)}</p>
  <p style="margin:0 0 14px;line-height:1.55;word-break:break-word;"><strong>메시지</strong><br>${esc(trunc(event.message, limits.bodyMsgMax))}</p>
  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#1d1d1f;">자동 분석·권장 조치</p>
  <ul style="margin:0;padding:0 0 0 18px;font-size:12px;color:#424245;">${analysisHtml}</ul>
  ${detailInBody ? `<p style="margin:16px 0 6px;font-size:12px;font-weight:600;color:#1d1d1f;">수집 detail (본문 일부, 전체는 첨부 JSON·PDF)</p><pre style="margin:0;padding:12px;background:#fafafa;border:1px solid #e8e8ed;border-radius:8px;font-size:10px;line-height:1.45;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Monaco,Consolas,monospace;">${esc(detailInBody)}</pre>` : ''}
  <p style="margin:16px 0 6px;font-size:12px;font-weight:600;color:#1d1d1f;">이벤트 시점 시스템 스냅샷</p>
  ${snapshotBlock(event)}
  <p style="margin:18px 0 0;font-size:11px;color:#aeaeb2;">일간 다이제스트는 자정 스케줄과 별개로, 본 메일은 감지 직후 발송되었습니다. 동일 유형 알림은 쿨다운 간격으로 묶일 수 있습니다.</p>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

function buildCompactInstantHtml(event: MonitorEvent, analysisText: string): string {
  const { bg, fg, label } = severityColor(event.severity);
  const analysisHtml = analysisToHtmlList(analysisText);
  const msgShort = esc(trunc(event.message, 480));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#f5f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;border:1px solid #e8e8ed;">
<tr><td style="padding:20px 22px 8px;font-family:${FF};">
  <span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:0.8px;padding:6px 14px;border-radius:100px;">${label}</span>
  <h1 style="margin:14px 0 0;font-size:18px;font-weight:600;color:#1d1d1f;line-height:1.35;">${esc(event.title)}</h1>
  <p style="margin:8px 0 0;font-size:12px;color:#6e6e73;">이벤트 ID <code style="background:#f5f5f7;padding:2px 6px;border-radius:4px;">${esc(event.id)}</code> · ${esc(event.timestamp)}</p>
</td></tr>
<tr><td style="padding:8px 22px;font-family:${FF};font-size:13px;color:#1d1d1f;">
  <p style="margin:0 0 12px;padding:12px;background:#f0f7ff;border-radius:8px;font-size:13px;line-height:1.55;">
    <strong>전체 본문·스냅샷·detail·로그 맥락</strong>은 첨부 <strong>PDF</strong>와 (해당 시) <strong>error/critical·warning 전용 .txt</strong>, 그리고 설정 시 <strong>JSON</strong>을 확인하세요.
  </p>
  <p style="margin:0 0 6px;"><strong>서버</strong> ${esc(event.serverId)} · <strong>카테고리</strong> ${esc(event.category)}</p>
  <p style="margin:0 0 14px;line-height:1.55;word-break:break-word;"><strong>메시지(발췌)</strong><br>${msgShort}</p>
  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#1d1d1f;">자동 분석·권장 조치</p>
  <ul style="margin:0;padding:0 0 0 18px;font-size:12px;color:#424245;">${analysisHtml}</ul>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

export async function buildInstantAlertPayload(
  event: MonitorEvent,
  analysisText: string,
  attachFullJson: boolean,
  to: string[],
): Promise<EmailPayload> {
  const { label } = severityColor(event.severity);
  const subject = `[모니터 즉시 알림][${label}] ${event.serverId} — ${trunc(event.title, 80)}`;

  const fullForPdf = buildInstantFullHtml(event, analysisText, {
    bodyMsgMax: PDF_BODY_MAX,
    bodyDetailJsonMax: PDF_BODY_MAX,
  });
  const pdfBuf = await renderHtmlToPdf(injectPdfChromeStyles(fullForPdf));

  const html = pdfBuf ? buildCompactInstantHtml(event, analysisText) : buildInstantFullHtml(event, analysisText, { bodyMsgMax: BODY_MSG_MAX, bodyDetailJsonMax: BODY_DETAIL_JSON_MAX });

  const attachments: { filename: string; content: Buffer }[] = [];
  if (pdfBuf) {
    attachments.push({ filename: `monitor-incident-${event.id}.pdf`, content: pdfBuf });
  }
  attachments.push(...buildInstantSeverityAttachments(event));
  if (attachFullJson) {
    attachments.push({
      filename: `monitor-event-${event.id}.json`,
      content: Buffer.from(JSON.stringify(event, null, 2), 'utf8'),
    });
  }

  return { to, subject, html, attachments: attachments.length ? attachments : undefined };
}
