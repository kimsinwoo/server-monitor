import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import si from 'systeminformation';
import type { SystemSnapshot } from '../types/monitor.types.js';

let lastNetRx = 0;
let lastNetTx = 0;
let lastNetTs = 0;

/** Linux: /proc/meminfo 의 MemAvailable — 커널·free -h 와 동일 계열 */
function readLinuxMemAvailableBytes(): { total: number; available: number } | null {
  if (process.platform !== 'linux' && process.platform !== 'android') return null;
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const parseKb = (key: string): number | null => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      if (!m?.[1]) return null;
      return parseInt(m[1], 10) * 1024;
    };
    const total = parseKb('MemTotal');
    let available = parseKb('MemAvailable');
    if (available === null) {
      const free = parseKb('MemFree');
      const buffers = parseKb('Buffers') ?? 0;
      const cached = parseKb('Cached') ?? 0;
      const sreclaim = parseKb('SReclaimable') ?? 0;
      if (free === null || total === null || total <= 0) return null;
      available = Math.min(total, free + buffers + cached + sreclaim);
    }
    if (total === null || total <= 0 || available === null || available < 0) return null;
    return { total, available: Math.min(available, total) };
  } catch {
    return null;
  }
}

/** macOS: vm_stat 기반 (wired+active+압축) — os.freemem/실패 시 stub 사용률보다 신뢰도 높음 */
function readDarwinRamFromVmStat(): { total: number; used: number; pageSize: number } | null {
  if (process.platform !== 'darwin') return null;
  try {
    const total = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf8', maxBuffer: 64 }).trim(), 10);
    if (!Number.isFinite(total) || total <= 0) return null;
    const vmOut = execSync('/usr/bin/vm_stat', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const pageSizeM = vmOut.match(/page size of (\d+) bytes/i);
    const pageSize =
      pageSizeM?.[1] !== undefined && pageSizeM[1] !== '' ? parseInt(pageSizeM[1], 10) : 4096;
    const getPages = (label: string): number => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^\\s*${escaped}:\\s+(\\d+)\\.`, 'm');
      const m = vmOut.match(re);
      if (!m?.[1]) return 0;
      return parseInt(m[1].replace(/,/g, ''), 10) || 0;
    };
    const wired = getPages('Pages wired down');
    const active = getPages('Pages active');
    const occupied = getPages('Pages occupied by compressor');
    const stored = getPages('Pages stored in compressor');
    const usedPages = wired + active + occupied + stored;
    if (usedPages <= 0) return null;
    const used = Math.min(total, usedPages * pageSize);
    return { total, used, pageSize };
  } catch {
    return null;
  }
}

/** systeminformation mem() 기반 보조 (다른 OS·폴백). available 이 비정상일 때 buffcache 보강 */
function ramFromSiMem(mem: Awaited<ReturnType<typeof si.mem>>): {
  ramUsedPercent: number;
  ramUsedMB: number;
  ramTotalMB: number;
  ramAvailableMB: number;
  ramMethod: 'systeminformation';
} {
  const total = mem.total;
  let available =
    typeof mem.available === 'number' && mem.available >= 0 && Number.isFinite(mem.available)
      ? mem.available
      : null;
  const buffcache = typeof mem.buffcache === 'number' && mem.buffcache >= 0 ? mem.buffcache : 0;
  if (available === null) {
    available = Math.min(total, mem.free + buffcache);
  } else if (process.platform === 'darwin' && buffcache === 0 && available <= mem.free * 1.02) {
    // vm_stat 미반영 stub 가능성: free+buffcache로 보정 시도
    const alt = Math.min(total, mem.free + buffcache);
    if (alt > available * 1.05) available = alt;
  }
  const usedExclApprox = Math.max(0, total - available);
  const ramTotalMB = total / (1024 * 1024);
  const ramUsedMB = usedExclApprox / (1024 * 1024);
  const ramUsedPercent = total > 0 ? (usedExclApprox / total) * 100 : 0;
  const ramAvailableMB = Math.max(0, total - usedExclApprox) / (1024 * 1024);
  return { ramUsedPercent, ramUsedMB, ramTotalMB, ramAvailableMB, ramMethod: 'systeminformation' };
}

export async function captureSystemSnapshot(): Promise<SystemSnapshot> {
  const [mem, load, fsSize, time, networkStats] = await Promise.all([
    si.mem(),
    si.currentLoad(),
    si.fsSize(),
    si.time(),
    si.networkStats(),
  ]);

  let ramUsedPercent = 0;
  let ramUsedMB = 0;
  let ramTotalMB = 0;
  let ramAvailableMB = 0;
  let ramMethod: SystemSnapshot['ramMethod'] = 'systeminformation';

  const linux = readLinuxMemAvailableBytes();
  if (linux) {
    const used = Math.max(0, linux.total - linux.available);
    ramTotalMB = linux.total / (1024 * 1024);
    ramUsedMB = used / (1024 * 1024);
    ramUsedPercent = linux.total > 0 ? (used / linux.total) * 100 : 0;
    ramAvailableMB = linux.available / (1024 * 1024);
    ramMethod = 'linux_proc_memavailable';
  } else {
    const darwin = readDarwinRamFromVmStat();
    if (darwin) {
      ramTotalMB = darwin.total / (1024 * 1024);
      ramUsedMB = darwin.used / (1024 * 1024);
      ramUsedPercent = darwin.total > 0 ? (darwin.used / darwin.total) * 100 : 0;
      ramAvailableMB = Math.max(0, darwin.total - darwin.used) / (1024 * 1024);
      ramMethod = 'darwin_vmstat';
    } else {
      const r = ramFromSiMem(mem);
      ramUsedPercent = r.ramUsedPercent;
      ramUsedMB = r.ramUsedMB;
      ramTotalMB = r.ramTotalMB;
      ramAvailableMB = r.ramAvailableMB;
      ramMethod = r.ramMethod;
    }
  }

  const rootFs = fsSize[0];
  const diskTotalGB = rootFs ? rootFs.size / (1024 * 1024 * 1024) : 0;
  const diskUsedGB = rootFs ? rootFs.used / (1024 * 1024 * 1024) : 0;
  const diskUsedPercent = rootFs?.use ?? 0;

  const iface = networkStats[0];
  const now = Date.now();
  let networkRxMBps = 0;
  let networkTxMBps = 0;
  if (iface && lastNetTs > 0) {
    const dt = (now - lastNetTs) / 1000;
    if (dt > 0) {
      networkRxMBps = Math.max(0, (iface.rx_bytes - lastNetRx) / (1024 * 1024) / dt);
      networkTxMBps = Math.max(0, (iface.tx_bytes - lastNetTx) / (1024 * 1024) / dt);
    }
  }
  if (iface) {
    lastNetRx = iface.rx_bytes;
    lastNetTx = iface.tx_bytes;
    lastNetTs = now;
  }

  return {
    cpuPercent: load.currentLoad ?? 0,
    ramUsedPercent,
    ramUsedMB,
    ramTotalMB,
    ramAvailableMB,
    ramMethod,
    diskUsedPercent,
    diskUsedGB,
    diskTotalGB,
    networkRxMBps,
    networkTxMBps,
    loadAvg1m: load.avgLoad ?? os.loadavg()[0] ?? 0,
    loadAvg5m: os.loadavg()[1] ?? 0,
    loadAvg15m: os.loadavg()[2] ?? 0,
    uptime: time.uptime ?? os.uptime(),
  };
}
