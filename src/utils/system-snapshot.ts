import os from 'node:os';
import si from 'systeminformation';
import type { SystemSnapshot } from '../types/monitor.types.js';

let lastNetRx = 0;
let lastNetTx = 0;
let lastNetTs = 0;

export async function captureSystemSnapshot(): Promise<SystemSnapshot> {
  const [mem, load, fsSize, time, networkStats] = await Promise.all([
    si.mem(),
    si.currentLoad(),
    si.fsSize(),
    si.time(),
    si.networkStats(),
  ]);

  // Linux: mem.used 는 캐시 포함으로 대시보드(50%대)와 다르게 90%대로 보일 수 있음.
  // MemAvailable 기준 = total - available (free 명령·대부분 호스팅 패널과 유사)
  const total = mem.total;
  const available = typeof mem.available === 'number' && mem.available >= 0 ? mem.available : mem.free;
  const usedExclApprox = Math.max(0, total - available);
  const ramTotalMB = total / (1024 * 1024);
  const ramUsedMB = usedExclApprox / (1024 * 1024);
  const ramUsedPercent = total > 0 ? (usedExclApprox / total) * 100 : 0;

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
