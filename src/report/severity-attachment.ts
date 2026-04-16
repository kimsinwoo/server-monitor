import fs from 'node:fs';
import type { MonitorEvent } from '../types/monitor.types.js';

const LOG_TAIL_MAX_BYTES = 96_000;

export function readLogTailForAttachment(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const n = Math.min(LOG_TAIL_MAX_BYTES, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, stat.size - n);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function formatEventBlock(e: MonitorEvent, includeLogTail: boolean): string {
  const lines: string[] = [];
  lines.push('──────────────');
  lines.push(`id: ${e.id}`);
  lines.push(`timestamp: ${e.timestamp}`);
  lines.push(`severity: ${e.severity}`);
  lines.push(`serverId: ${e.serverId}`);
  lines.push(`category: ${e.category}`);
  lines.push(`title: ${e.title}`);
  lines.push('message:');
  lines.push(e.message);
  if (e.detail && Object.keys(e.detail).length > 0) {
    lines.push('detail (JSON):');
    lines.push(JSON.stringify(e.detail, null, 2));
  }
  const logFile = e.detail && typeof (e.detail as { logFile?: unknown }).logFile === 'string' ? (e.detail as { logFile: string }).logFile : null;
  if (includeLogTail && logFile) {
    const tail = readLogTailForAttachment(logFile);
    if (tail != null) {
      lines.push('');
      lines.push(`--- log tail (${logFile}, 마지막 약 ${LOG_TAIL_MAX_BYTES}바이트) ---`);
      lines.push(tail);
    } else {
      lines.push('');
      lines.push(`--- log tail 읽기 실패: ${logFile} ---`);
    }
  }
  lines.push(`resolved: ${e.resolved ? 'yes' : 'no'}${e.resolvedAt ? ` at ${e.resolvedAt}` : ''}`);
  return lines.join('\n');
}

/** 일간 다이제스트: critical·error / warning 각각 전체 건을 텍스트로 묶음 */
export function buildDailyDigestSeverityText(events: MonitorEvent[], bucket: 'error' | 'warning'): Buffer | null {
  const filtered =
    bucket === 'error' ? events.filter((e) => e.severity === 'critical' || e.severity === 'error') : events.filter((e) => e.severity === 'warning');
  if (filtered.length === 0) return null;
  const header =
    bucket === 'error' ?
      '=== 일간 리포트: Critical / Error 이벤트 (전문) ===\n'
    : '=== 일간 리포트: Warning 이벤트 (전문) ===\n';
  const body = filtered.map((e) => formatEventBlock(e, true)).join('\n\n');
  return Buffer.from(`${header}\n${body}`, 'utf8');
}

/** 즉시 알림 1건: 심각도에 맞는 단일 텍스트 첨부(로그 파일이 있으면 tail 포함) */
export function buildInstantSeverityAttachments(event: MonitorEvent): { filename: string; content: Buffer }[] {
  const out: { filename: string; content: Buffer }[] = [];
  const full = formatEventBlock(event, true);
  if (event.severity === 'critical' || event.severity === 'error') {
    out.push({
      filename: `monitor-incident-${event.id}-error-or-critical.txt`,
      content: Buffer.from(full, 'utf8'),
    });
  } else if (event.severity === 'warning') {
    out.push({
      filename: `monitor-incident-${event.id}-warning.txt`,
      content: Buffer.from(full, 'utf8'),
    });
  }
  return out;
}
