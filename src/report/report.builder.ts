import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorEvent } from '../types/monitor.types.js';
import type { EventsSummary } from '../aggregator/event.store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rowStyle: Record<string, string> = {
  critical: 'background:#fee2e2;color:#991b1b;',
  error: 'background:#fef3c7;color:#92400e;',
  warning: 'background:#eff6ff;color:#1e40af;',
  info: 'background:#f9fafb;color:#374151;',
};

export function getSeveritySummaryLine(events: MonitorEvent[]): string {
  const c = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const e of events) {
    c[e.severity] += 1;
  }
  return `critical ${c.critical}건, error ${c.error}건, warning ${c.warning}건, info ${c.info}건`;
}

export class ReportBuilder {
  async build(events: MonitorEvent[], date: string, summary: EventsSummary): Promise<string> {
    const tplPath = path.join(__dirname, 'templates', 'daily-digest.html');
    let html = fs.readFileSync(tplPath, 'utf8');
    const dateRange = `${date} 00:00 ~ 23:59 (타임존 기준 리포트 대상일)`;
    html = html.replace('{{DATE_RANGE}}', dateRange);
    html = html.replace('{{SUMMARY_LINE}}', getSeveritySummaryLine(events));

    const tables = ['critical', 'error', 'warning', 'info']
      .map((sev) => this.renderTable(sev, events.filter((e) => e.severity === sev)))
      .join('');
    html = html.replace('{{EVENT_TABLES}}', tables || '<p style="font-size:13px;color:#6b7280;">이벤트 없음</p>');

    const catStats = Object.entries(summary.byCategory)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
    html = html.replace('{{CATEGORY_STATS}}', catStats || '—');

    const resolved = events.filter((e) => e.resolved);
    const resolvedHtml =
      resolved.length === 0
        ? '<p style="font-size:13px;color:#6b7280;">없음</p>'
        : `<ul style="margin:0;padding-left:18px;font-size:13px;color:#374151;">${resolved
            .map(
              (e) =>
                `<li>${e.timestamp} — ${e.title} (${e.duration ?? 0}ms)</li>`,
            )
            .join('')}</ul>`;
    html = html.replace('{{RESOLVED_SECTION}}', resolvedHtml);

    const criticalTitles = events.filter((e) => e.severity === 'critical').map((e) => e.title);
    const checklist =
      criticalTitles.length === 0
        ? '<p style="font-size:13px;color:#6b7280;">critical 이벤트 없음</p>'
        : `<ul style="margin:0;padding-left:18px;font-size:13px;color:#374151;">${criticalTitles
            .map((t) => `<li>즉시 확인: ${t}</li>`)
            .join('')}</ul>`;
    html = html.replace('{{ACTION_CHECKLIST}}', checklist);

    return html;
  }

  private renderTable(severity: string, rows: MonitorEvent[]): string {
    if (rows.length === 0) return '';
    const style = rowStyle[severity] ?? rowStyle.info;
    const head = `<h3 style="margin:16px 0 8px;font-size:14px;text-transform:uppercase;color:#374151;">${severity}</h3>`;
    const table = `
<table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;margin-bottom:8px;">
  <tr style="background:#f3f4f6;color:#111827;">
    <th align="left">시각</th><th align="left">서버</th><th align="left">카테고리</th><th align="left">제목</th>
    <th align="right">지속(ms)</th><th align="right">CPU%</th><th align="right">RAM%</th>
  </tr>
  ${rows
    .map(
      (e) => `<tr style="${style}">
    <td>${e.timestamp}</td>
    <td>${e.serverId}</td>
    <td>${e.category}</td>
    <td>${this.escape(e.title)}</td>
    <td align="right">${e.duration ?? '—'}</td>
    <td align="right">${e.systemSnapshot.cpuPercent.toFixed(0)}</td>
    <td align="right">${e.systemSnapshot.ramUsedPercent.toFixed(0)}</td>
  </tr>`,
    )
    .join('')}
</table>`;
    return head + table;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
