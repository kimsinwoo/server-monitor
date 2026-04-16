import type { EventsSummary } from '../aggregator/event.store.js';
import type { MonitorEvent } from '../types/monitor.types.js';
import { getSeveritySummaryLine } from './report.builder.js';

const FF = 'Helvetica Neue,Helvetica,Arial,sans-serif';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatShortTime(iso: string): string {
  if (iso.length >= 16 && iso.includes('T')) {
    return iso.slice(11, 16);
  }
  return iso.slice(0, 16);
}

/**
 * PDF 첨부 시 본문이 클라이언트에서 잘리는 것을 줄이기 위한 짧은 요약 HTML.
 * 전문은 PDF·텍스트 첨부를 보라고 안내.
 */
export function buildCompactDailyDigestEmailBody(date: string, events: MonitorEvent[], summary: EventsSummary): string {
  const summaryLine = getSeveritySummaryLine(events);
  const recent = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-15).reverse();
  const rows = recent
    .map((e) => {
      const sev = esc(e.severity);
      const t = esc(formatShortTime(e.timestamp));
      const srv = esc(e.serverId);
      const tit = esc(e.title.length > 72 ? `${e.title.slice(0, 72)}…` : e.title);
      return `<tr><td style="padding:6px 8px;border-bottom:1px solid #e8e8ed;font-size:12px;color:#6e6e73;font-family:${FF};white-space:nowrap;">${t}</td><td style="padding:6px 8px;border-bottom:1px solid #e8e8ed;font-size:11px;font-weight:600;font-family:${FF};">${sev}</td><td style="padding:6px 8px;border-bottom:1px solid #e8e8ed;font-size:12px;color:#1d1d1f;font-family:${FF};">${srv}</td><td style="padding:6px 8px;border-bottom:1px solid #e8e8ed;font-size:12px;color:#424245;font-family:${FF};">${tit}</td></tr>`;
    })
    .join('');

  const catTop = Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, n]) => `${esc(k)} ${n}`)
    .join(' · ');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#f5f5f7;font-family:${FF};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;border:1px solid #e8e8ed;">
<tr><td style="padding:22px 24px;">
  <h1 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#1d1d1f;">일간 리포트 (요약)</h1>
  <p style="margin:0;font-size:13px;color:#6e6e73;">대상일: ${esc(date)} (타임존 기준)</p>
  <p style="margin:12px 0 0;font-size:14px;color:#1d1d1f;line-height:1.5;"><strong>집계</strong> ${esc(summaryLine)}</p>
  <p style="margin:8px 0 0;font-size:12px;color:#6e6e73;">카테고리 상위: ${catTop || '—'}</p>
  <p style="margin:16px 0 0;padding:12px;background:#f0f7ff;border-radius:8px;font-size:13px;color:#1d1d1f;line-height:1.55;">
    <strong>전체 표·상세 메시지·JSON</strong>는 첨부 <strong>PDF</strong>와, Critical·Error / Warning 별 <strong>텍스트(.txt)</strong> 파일을 확인하세요. (이 본문은 최근 이벤트 ${recent.length}건만 미리보기입니다.)
  </p>
</td></tr>
<tr><td style="padding:0 24px 22px;">
  <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#6e6e73;">최근 이벤트 (시간순 마지막 15건)</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e8e8ed;border-radius:8px;">
    <tr style="background:#fafafa;"><th align="left" style="padding:8px;font-size:11px;color:#6e6e73;">시각</th><th align="left" style="padding:8px;font-size:11px;color:#6e6e73;">심각도</th><th align="left" style="padding:8px;font-size:11px;color:#6e6e73;">서버</th><th align="left" style="padding:8px;font-size:11px;color:#6e6e73;">제목</th></tr>
    ${rows || `<tr><td colspan="4" style="padding:12px;font-size:13px;color:#6e6e73;">이벤트 없음</td></tr>`}
  </table>
</td></tr>
</table>
</td></tr></table></body></html>`;
}
