import os from 'node:os';
import si from 'systeminformation';
import type { Category, MonitorConfig, MonitorEvent } from '../types/monitor.types.js';
import { LOAD_PER_CORE_MULTIPLIER, SWAP_WARNING_PERCENT } from '../config/thresholds.js';
import { BaseCollector } from './base.collector.js';
import { captureSystemSnapshot } from '../utils/system-snapshot.js';

export class SystemCollector extends BaseCollector {
  readonly id = 'system';
  readonly category: Category = 'system';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    const snapshot = await captureSystemSnapshot();
    const mem = await si.mem();
    const net = await si.networkStats();
    const cores = Math.max(1, os.cpus().length);
    const { thresholds } = this.config;

    const swapTotal = mem.swaptotal ?? 0;
    const swapUsed = mem.swapused ?? 0;
    const swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

    const push = (condition: boolean, e: Omit<MonitorEvent, 'id' | 'timestamp' | 'systemSnapshot'>) => {
      if (condition) events.push(this.buildEvent(snapshot, e));
    };

    push(snapshot.cpuPercent >= thresholds.cpu.critical, {
      serverId: this.config.servers[0]?.id ?? 'server-01',
      category: 'system',
      severity: 'critical',
      title: 'CPU 사용률 위험',
      message: `CPU ${snapshot.cpuPercent.toFixed(1)}% (임계: ${thresholds.cpu.critical}%)`,
      detail: { cpuPercent: snapshot.cpuPercent },
    });

    push(
      snapshot.cpuPercent >= thresholds.cpu.warning && snapshot.cpuPercent < thresholds.cpu.critical,
      {
        serverId: this.config.servers[0]?.id ?? 'server-01',
        category: 'system',
        severity: 'warning',
        title: 'CPU 사용률 경고',
        message: `CPU ${snapshot.cpuPercent.toFixed(1)}% (경고: ${thresholds.cpu.warning}%)`,
        detail: { cpuPercent: snapshot.cpuPercent },
      },
    );

    push(snapshot.ramUsedPercent >= thresholds.ram.critical, {
      serverId: this.config.servers[0]?.id ?? 'server-01',
      category: 'system',
      severity: 'critical',
      title: '메모리 사용률 위험',
      message: `RAM ${snapshot.ramUsedPercent.toFixed(1)}% 사용`,
      detail: { ramUsedPercent: snapshot.ramUsedPercent },
    });

    push(
      snapshot.ramUsedPercent >= thresholds.ram.warning && snapshot.ramUsedPercent < thresholds.ram.critical,
      {
        serverId: this.config.servers[0]?.id ?? 'server-01',
        category: 'system',
        severity: 'warning',
        title: '메모리 사용률 경고',
        message: `RAM ${snapshot.ramUsedPercent.toFixed(1)}% 사용`,
        detail: { ramUsedPercent: snapshot.ramUsedPercent },
      },
    );

    push(snapshot.diskUsedPercent >= thresholds.disk.critical, {
      serverId: this.config.servers[0]?.id ?? 'server-01',
      category: 'system',
      severity: 'critical',
      title: '디스크 사용률 위험',
      message: `Disk ${snapshot.diskUsedPercent.toFixed(1)}% 사용`,
      detail: { diskUsedPercent: snapshot.diskUsedPercent },
    });

    push(
      snapshot.diskUsedPercent >= thresholds.disk.warning &&
        snapshot.diskUsedPercent < thresholds.disk.critical,
      {
        serverId: this.config.servers[0]?.id ?? 'server-01',
        category: 'system',
        severity: 'warning',
        title: '디스크 사용률 경고',
        message: `Disk ${snapshot.diskUsedPercent.toFixed(1)}% 사용`,
        detail: { diskUsedPercent: snapshot.diskUsedPercent },
      },
    );

    const ifaceErrors = net.reduce((acc, n) => acc + (n.rx_errors ?? 0) + (n.tx_errors ?? 0), 0);
    push(ifaceErrors > 0, {
      serverId: this.config.servers[0]?.id ?? 'server-01',
      category: 'system',
      severity: 'error',
      title: '네트워크 인터페이스 오류',
      message: `누적 RX/TX 에러 합계: ${ifaceErrors}`,
      detail: { networkErrors: ifaceErrors },
    });

    push(snapshot.loadAvg1m > cores * LOAD_PER_CORE_MULTIPLIER, {
      serverId: this.config.servers[0]?.id ?? 'server-01',
      category: 'system',
      severity: 'warning',
      title: 'Load average 과다',
      message: `load1m ${snapshot.loadAvg1m.toFixed(2)} (코어 ${cores} × ${LOAD_PER_CORE_MULTIPLIER})`,
      detail: { loadAvg1m: snapshot.loadAvg1m, cores },
    });

    push(swapPct > SWAP_WARNING_PERCENT, {
      serverId: this.config.servers[0]?.id ?? 'server-01',
      category: 'system',
      severity: 'warning',
      title: '스왑 사용률 경고',
      message: `Swap ${swapPct.toFixed(1)}% 사용`,
      detail: { swapUsedPercent: swapPct },
    });

    return events;
  }
}
