import mqtt from 'mqtt';
import type { Category, MonitorEvent } from '../types/monitor.types.js';
import type { MonitorConfig } from '../types/monitor.types.js';
import { BaseCollector } from './base.collector.js';

export class MqttCollector extends BaseCollector {
  readonly id = 'mqtt';
  readonly category: Category = 'mqtt';
  readonly intervalMs: number;

  constructor(private readonly config: MonitorConfig) {
    super();
    this.intervalMs = config.collectIntervalMs;
  }

  async collect(): Promise<MonitorEvent[]> {
    const events: MonitorEvent[] = [];
    for (const broker of this.config.mqtt.brokers) {
      const clientId = broker.clientId ?? `monitor-${Date.now()}`;
      const timeoutMs = broker.heartbeatTimeoutMs ?? 10_000;
      try {
        await new Promise<void>((resolve, reject) => {
          const client = mqtt.connect(broker.url, {
            clientId,
            username: broker.username,
            password: broker.password,
            connectTimeout: timeoutMs,
          });
          const t = setTimeout(() => {
            client.end(true);
            reject(new Error('MQTT connect timeout'));
          }, timeoutMs);
          client.on('connect', () => {
            clearTimeout(t);
            client.end(true);
            resolve();
          });
          client.on('error', (err) => {
            clearTimeout(t);
            client.end(true);
            reject(err);
          });
        });
      } catch (err) {
        let host = '';
        let port = '';
        try {
          const urlObj = new URL(broker.url);
          host = urlObj.hostname;
          port = urlObj.port || (urlObj.protocol === 'mqtts:' ? '8883' : '1883');
        } catch {
          host = broker.url;
          port = '';
        }
        const ev = await this.evaluate(true, {
          serverId: broker.serverId,
          category: 'mqtt',
          severity: 'critical',
          title: 'MQTT 연결 실패',
          message: err instanceof Error ? err.message : String(err),
          detail: {
            broker: host,
            port,
            clientId,
            lastHeartbeat: null,
          },
        });
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}
