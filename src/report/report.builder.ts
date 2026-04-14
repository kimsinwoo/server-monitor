import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorEvent, Severity } from '../types/monitor.types.js';
import type { EventsSummary } from '../aggregator/event.store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FF = 'Helvetica Neue,Helvetica,Arial,sans-serif';

/** 이메일 본문 과도 방지 */
const MESSAGE_MAX = 600;
const DETAIL_JSON_MAX = 1800;

function countBySeverity(events: MonitorEvent[]): Record<Severity, number> {
  const c = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const e of events) {
    c[e.severity] += 1;
  }
  return c;
}

export function getSeveritySummaryLine(events: MonitorEvent[]): string {
  const c = countBySeverity(events);
  return `critical ${c.critical}건, error ${c.error}건, warning ${c.warning}건, info ${c.info}건`;
}

function dotColor(sev: Severity): string {
  switch (sev) {
    case 'critical':
      return '#ff3b30';
    case 'error':
      return '#e03636';
    case 'warning':
      return '#ff9500';
    default:
      return '#0071e3';
  }
}

function rowBackground(sev: Severity): string {
  switch (sev) {
    case 'critical':
      return '#fff8f8';
    case 'error':
      return '#fff5f5';
    case 'warning':
      return '#fffaf2';
    default:
      return '#f5f5f7';
  }
}

function detailInsetBackground(sev: Severity): string {
  switch (sev) {
    case 'critical':
      return '#fff0f0';
    case 'error':
      return '#fff8f0';
    case 'warning':
      return '#fffbf0';
    default:
      return '#f9f9fb';
  }
}

function formatShortTime(iso: string): string {
  if (iso.length >= 16 && iso.includes('T')) {
    return iso.slice(11, 16);
  }
  return iso.slice(0, 16);
}

function statusLabel(e: MonitorEvent): { text: string; color: string } {
  if (e.resolved) return { text: '해소됨', color: '#34c759' };
  if (e.severity === 'warning') return { text: '확인중', color: '#cc6600' };
  if (e.severity === 'info') return { text: '정보', color: '#0071e3' };
  return { text: '미처리', color: '#cc0000' };
}

function renderHeaderBadge(counts: Record<Severity, number>): string {
  if (counts.critical > 0) {
    return `<span style="display:inline-block;background-color:#fff2f2;border:1px solid #ffd0d0;color:#cc0000;font-size:11px;font-weight:600;letter-spacing:0.8px;padding:5px 13px;border-radius:100px;font-family:${FF};text-transform:uppercase;">Critical</span>`;
  }
  if (counts.error > 0) {
    return `<span style="display:inline-block;background-color:#fff2f2;border:1px solid #ffd0d0;color:#b00000;font-size:11px;font-weight:600;letter-spacing:0.8px;padding:5px 13px;border-radius:100px;font-family:${FF};text-transform:uppercase;">Error</span>`;
  }
  if (counts.warning > 0) {
    return `<span style="display:inline-block;background-color:#fff8f0;border:1px solid #ffe0c2;color:#cc6600;font-size:11px;font-weight:600;letter-spacing:0.8px;padding:5px 13px;border-radius:100px;font-family:${FF};text-transform:uppercase;">Warning</span>`;
  }
  return `<span style="display:inline-block;background-color:#f0f7ff;border:1px solid #cfe5ff;color:#0071e3;font-size:11px;font-weight:600;letter-spacing:0.8px;padding:5px 13px;border-radius:100px;font-family:${FF};text-transform:uppercase;">정상</span>`;
}

export class ReportBuilder {
  async build(events: MonitorEvent[], date: string, summary: EventsSummary): Promise<string> {
    const tplPath = path.join(__dirname, 'templates', 'daily-digest.html');
    let html = fs.readFileSync(tplPath, 'utf8');
    const dateRange = `${date} 00:00 ~ 23:59 (타임존 기준 리포트 대상일)`;
    const counts = countBySeverity(events);

    html = html.replace('{{DATE_RANGE}}', dateRange);
    html = html.replace('{{SUMMARY_LINE}}', getSeveritySummaryLine(events));
    html = html.replace('{{HEADER_BADGE}}', renderHeaderBadge(counts));
    html = html.replace('{{CRITICAL_COUNT}}', String(counts.critical));
    html = html.replace('{{ERROR_COUNT}}', String(counts.error));
    html = html.replace('{{WARNING_COUNT}}', String(counts.warning));
    html = html.replace('{{INFO_COUNT}}', String(counts.info));
    html = html.replace('{{HUB_WATCH_DIGEST}}', this.renderHubWatchDigest(events));
    html = html.replace('{{EVENT_TABLES}}', this.renderEventTables(events));
    html = html.replace('{{CATEGORY_BREAKDOWN}}', this.renderCategoryBreakdown(summary));
    html = html.replace('{{RESOLVED_SECTION}}', this.renderResolvedSection(events));
    html = html.replace('{{ACTION_CHECKLIST}}', this.renderCriticalChecklist(events.filter((e) => e.severity === 'critical')));

    return html;
  }

  /** 허브 감시(텔레메트리 공백, state:hub 지연, LWT) — 일간 요약 전용 블록 */
  private renderHubWatchDigest(events: MonitorEvent[]): string {
    const hub = events.filter(
      (e) => e.category === 'hub' && e.detail && (e.detail as { source?: string }).source === 'hub-watch',
    );
    if (hub.length === 0) {
      return `<tr><td style="padding:0 48px 24px;">
        <p style="margin:0;font-size:12px;color:#6e6e73;font-family:${FF};">해당 일자에 기록된 허브 감시 이벤트가 없습니다. (모니터가 <code style="font-size:11px;">/api/monitor/hub-watch</code>를 폴링하고 허브에서 사건이 적재된 경우에만 표시)</p>
      </td></tr>`;
    }
    const byType: Record<string, number> = {};
    for (const e of hub) {
      const t = String((e.detail as { incidentType?: string }).incidentType ?? 'unknown');
      byType[t] = (byType[t] ?? 0) + 1;
    }
    const typeLine = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${this.escape(k)} ${n}건`)
      .join(' · ');
    const crit = hub.filter((e) => e.severity === 'critical').length;
    const warn = hub.filter((e) => e.severity === 'warning').length;
    const cards = hub
      .slice(0, 25)
      .map((e) => {
        const d = e.detail as { hubId?: string; incidentType?: string };
        const title = this.escape(e.title);
        const msg = this.escape(this.truncate(e.message, 200));
        const ts = this.escape(formatShortTime(e.timestamp));
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;"><tr><td style="background:#fafafa;border:1px solid #e8e8ed;border-radius:8px;padding:12px 14px;font-family:${FF};">
          <p style="margin:0 0 4px;font-size:11px;color:#6e6e73;">${ts} · ${this.escape(String(d.hubId ?? ''))} · ${this.escape(String(d.incidentType ?? ''))}</p>
          <p style="margin:0;font-size:13px;font-weight:600;color:#1d1d1f;">${title}</p>
          <p style="margin:6px 0 0;font-size:12px;color:#424245;line-height:1.5;">${msg}</p>
        </td></tr></table>`;
      })
      .join('');
    const more = hub.length > 25 ? `<p style="margin:8px 0 0;font-size:11px;color:#6e6e73;">외 ${hub.length - 25}건은 심각도별 이벤트 표에서 확인</p>` : '';
    return `<tr><td style="padding:0 48px 8px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:600;color:#6e6e73;letter-spacing:1.2px;text-transform:uppercase;font-family:${FF};">허브 감시 (텔레메트리 공백 · state:hub · LWT)</p>
      <p style="margin:0 0 12px;font-size:12px;color:#1d1d1f;line-height:1.55;font-family:${FF};">요약: Critical ${crit}건 · Warning ${warn}건 · 유형별 ${typeLine}</p>
      ${cards}${more}
    </td></tr>`;
  }

  /** 심각도별 구분선 + 정렬된 4열(시각·서버·이벤트·지표) + 상세 블록 */
  private renderEventTables(events: MonitorEvent[]): string {
    if (events.length === 0) {
      return `<tr><td colspan="4" style="padding:16px 0;font-size:13px;color:#6e6e73;text-align:center;font-family:${FF};">이벤트 없음</td></tr>`;
    }

    const order: Severity[] = ['critical', 'error', 'warning', 'info'];
    const labels: Record<Severity, string> = {
      critical: 'Critical',
      error: 'Error',
      warning: 'Warning',
      info: 'Info',
    };

    const parts: string[] = [];
    for (const sev of order) {
      const rows = events.filter((e) => e.severity === sev);
      if (rows.length === 0) continue;

      parts.push(`
                <tr><td colspan="4" style="height:1px;background-color:#e8e8ed;font-size:0;line-height:0;padding:0;">&nbsp;</td></tr>
                <tr>
                  <td colspan="4" style="padding:14px 0 6px;font-size:11px;font-weight:600;color:#6e6e73;letter-spacing:1.2px;text-transform:uppercase;font-family:${FF};">${labels[sev]} · ${rows.length}건</td>
                </tr>`);

      for (const e of rows) {
        parts.push(this.renderOneEventBlock(e));
      }
    }

    return parts.join('');
  }

  private renderOneEventBlock(e: MonitorEvent): string {
    const st = statusLabel(e);
    const bg = rowBackground(e.severity);
    const dot = dotColor(e.severity);
    const cpu = e.systemSnapshot.cpuPercent.toFixed(0);
    const ram = e.systemSnapshot.ramUsedPercent.toFixed(0);
    const dur = e.duration !== undefined ? `${e.duration}ms` : '—';
    const title = this.escape(e.title);
    const server = this.escape(e.serverId);
    const cat = this.escape(e.category);
    const msgShort = this.escape(this.truncate(e.message, 120));
    const time = this.escape(formatShortTime(e.timestamp));

    const main = `
                <tr><td colspan="4" style="height:1px;background-color:#e8e8ed;font-size:0;line-height:0;padding:0;">&nbsp;</td></tr>
                <tr style="background-color:${bg};">
                  <td width="19%" valign="top" style="padding:13px 8px 13px 0;font-size:12px;color:#6e6e73;font-family:${FF};white-space:nowrap;">${time}</td>
                  <td width="24%" valign="top" style="padding:13px 8px 13px 0;font-family:${FF};">
                    <span style="display:inline-block;width:5px;height:5px;background-color:${dot};border-radius:50%;margin-right:6px;vertical-align:middle;"></span><span style="font-size:12px;font-weight:600;color:#1d1d1f;word-break:break-all;">${server}</span>
                  </td>
                  <td width="49%" valign="top" style="padding:13px 8px 13px 0;font-size:12px;color:#1d1d1f;font-family:${FF};word-break:break-word;">
                    <span style="font-weight:600;">${cat}</span><span style="color:#aeaeb2;"> · </span>${title}
                    <p style="margin:4px 0 0;font-size:11px;color:#6e6e73;line-height:1.45;font-family:${FF};">${msgShort}</p>
                  </td>
                  <td width="8%" valign="top" align="right" style="padding:13px 0 13px 8px;text-align:right;font-size:10px;font-weight:600;color:${st.color};font-family:${FF};line-height:1.35;white-space:nowrap;">
                    <span style="display:block;">${st.text}</span>
                    <span style="display:block;color:#6e6e73;font-weight:500;">${cpu}/${ram}%</span>
                    <span style="display:block;color:#aeaeb2;font-weight:500;">${this.escape(dur)}</span>
                  </td>
                </tr>`;

    const detail = this.renderEventDetailRow(e);
    return main + detail;
  }

  private renderEventDetailRow(e: MonitorEvent): string {
    const inset = detailInsetBackground(e.severity);
    const msg = this.escape(this.truncate(e.message, MESSAGE_MAX));
    const json = this.formatDetailJson(e.detail);
    const jsonHtml = json
      ? `<div style="margin-top:8px;"><span style="font-weight:600;color:#1d1d1f;font-size:11px;font-family:${FF};">세부(JSON)</span><pre style="margin:6px 0 0;padding:10px;background:#ffffff;border:1px solid #e8e8ed;border-radius:6px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Monaco,Consolas,monospace;">${this.escape(this.truncate(json, DETAIL_JSON_MAX))}</pre></div>`
      : '';
    const snap = `<div style="margin-top:8px;font-size:11px;color:#6e6e73;font-family:${FF};line-height:1.5;">${this.escape(this.snapshotOneLiner(e))}</div>`;

    return `
                <tr>
                  <td colspan="4" valign="top" style="padding:0 0 0 0;background-color:${inset};border-bottom:1px solid #e8e8ed;">
                    <div style="padding:12px 14px 14px 14px;font-size:12px;line-height:1.5;color:#1d1d1f;font-family:${FF};">
                      <span style="font-weight:600;color:#1d1d1f;">메시지</span>
                      <div style="margin-top:4px;word-break:break-word;">${msg}</div>
                      ${jsonHtml}
                      ${snap}
                    </div>
                  </td>
                </tr>`;
  }

  private renderCategoryBreakdown(summary: EventsSummary): string {
    const entries = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      return `<p style="margin:0;font-size:13px;color:#6e6e73;font-family:${FF};">—</p>`;
    }
    const max = Math.max(...entries.map(([, v]) => v), 1);
    const rows = entries.map(([name, n]) => {
      const pct = Math.round((n / max) * 100);
      const label = this.escape(name);
      const count = this.escape(String(n));
      return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
                <tr>
                  <td width="96" valign="middle" style="font-size:12px;color:#6e6e73;padding-right:12px;font-family:${FF};word-break:break-all;">${label}</td>
                  <td valign="middle" style="padding:0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                      <td width="${pct}%" bgcolor="#1d1d1f" style="height:4px;font-size:0;line-height:0;background-color:#1d1d1f;">&nbsp;</td>
                      <td bgcolor="#e8e8ed" style="height:4px;font-size:0;line-height:0;background-color:#e8e8ed;">&nbsp;</td>
                    </tr></table>
                  </td>
                  <td width="44" valign="middle" style="text-align:right;font-size:12px;font-weight:600;color:#1d1d1f;padding-left:12px;font-family:${FF};white-space:nowrap;">${count}</td>
                </tr>
              </table>`;
    });
    return rows.join('');
  }

  private renderResolvedSection(events: MonitorEvent[]): string {
    const resolved = events.filter((r) => r.resolved);
    if (resolved.length === 0) {
      return `<p style="margin:0;font-size:13px;color:#6e6e73;font-family:${FF};">없음</p>`;
    }

    return resolved
      .map((e) => {
        const title = this.escape(e.title);
        const server = this.escape(e.serverId);
        const ts = this.escape(e.timestamp);
        const dur = e.duration !== undefined ? `${e.duration}ms` : '—';
        return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
                <tr>
                  <td width="20" valign="top" style="padding-top:1px;">
                    <div style="width:16px;height:16px;background-color:#34c759;border-radius:50%;text-align:center;line-height:17px;font-size:10px;color:#ffffff;font-family:${FF};font-weight:700;">✓</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;font-size:13px;font-weight:600;color:#1d1d1f;font-family:${FF};">${server} · ${title}</p>
                    <p style="margin:3px 0 0;font-size:12px;color:#6e6e73;font-family:${FF};word-break:break-word;">${ts} · 지속 ${this.escape(dur)}${e.resolvedAt ? ` · 복구 ${this.escape(e.resolvedAt)}` : ''}</p>
                  </td>
                </tr>
              </table>`;
      })
      .join('');
  }

  /** critical 중복 제거 — 템플릿 카드 스타일 */
  private renderCriticalChecklist(criticals: MonitorEvent[]): string {
    if (criticals.length === 0) {
      return `<p style="margin:0;font-size:13px;color:#6e6e73;font-family:${FF};">critical 이벤트 없음</p>`;
    }
    const seen = new Set<string>();
    const cards: string[] = [];
    for (const e of criticals) {
      const detailJson = this.formatDetailJson(e.detail);
      const key = `${e.title}\n${e.message}\n${detailJson ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const title = this.escape(e.title);
      const server = this.escape(e.serverId);
      const msg = this.escape(this.truncate(e.message, MESSAGE_MAX));
      const detailBlock = detailJson
        ? `<p style="margin:8px 0 0;font-size:12px;color:#6e6e73;line-height:1.55;font-family:${FF};word-break:break-word;"><span style="font-weight:600;color:#1d1d1f;">세부</span> ${this.escape(this.truncate(detailJson, 900))}</p>`
        : '';
      const snap = `<p style="margin:6px 0 0;font-size:12px;color:#6e6e73;line-height:1.5;font-family:${FF};word-break:break-word;">${this.escape(this.snapshotOneLiner(e))}</p>`;

      cards.push(`
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
                <tr>
                  <td style="border-left:2px solid #ff3b30;background-color:#fff8f8;padding:14px 16px;">
                    <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#ff3b30;letter-spacing:0.6px;text-transform:uppercase;font-family:${FF};">긴급</p>
                    <p style="margin:0;font-size:13px;color:#1d1d1f;line-height:1.6;font-family:${FF};word-break:break-word;"><span style="font-weight:600;">${server}</span> — ${title}</p>
                    <p style="margin:6px 0 0;font-size:13px;color:#424245;line-height:1.55;font-family:${FF};word-break:break-word;">${msg}</p>
                    ${detailBlock}
                    ${snap}
                  </td>
                </tr>
              </table>`);
    }
    return cards.join('');
  }

  private snapshotOneLiner(e: MonitorEvent): string {
    const s = e.systemSnapshot;
    const ramMeta =
      s.ramMethod === 'linux_proc_memavailable'
        ? ' · RAM=MemAvailable'
        : s.ramMethod === 'darwin_vmstat'
          ? ' · RAM=vm_stat'
          : '';
    return `이벤트 시점 리소스: RAM ${s.ramUsedPercent.toFixed(1)}% (${s.ramUsedMB.toFixed(0)} / ${s.ramTotalMB.toFixed(0)} MB)${ramMeta} · 디스크 ${s.diskUsedPercent.toFixed(1)}% · 부하(1/5/15m) ${s.loadAvg1m.toFixed(2)} / ${s.loadAvg5m.toFixed(2)} / ${s.loadAvg15m.toFixed(2)} · 업타임 ${Math.floor(s.uptime / 3600)}h`;
  }

  private formatDetailJson(detail?: Record<string, unknown>): string | null {
    if (!detail || Object.keys(detail).length === 0) return null;
    try {
      return JSON.stringify(detail, null, 2);
    } catch {
      return null;
    }
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
