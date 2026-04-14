import 'dotenv/config';
import { loadMonitorConfig } from './config/monitor.config.js';
import { EventStore } from './aggregator/event.store.js';
import { EventAggregator } from './aggregator/event.aggregator.js';
import { InstantAlertDispatcher } from './aggregator/instant-alert.dispatcher.js';
import { ReportBuilder } from './report/report.builder.js';
import { createEmailSender } from './mailer/email.sender.js';
import { startCronSchedulers } from './scheduler/cron.scheduler.js';
import { logger } from './utils/logger.js';
import { SystemCollector } from './collectors/system.collector.js';
import { HttpCollector } from './collectors/http.collector.js';
import type { BaseCollector } from './collectors/base.collector.js';
import type { MonitorConfig } from './types/monitor.types.js';

/**
 * 설정에 실제로 쓰는 수집기만 동적 import → 미사용 패키지(mqtt, ioredis, pm2, dockerode 등) 로드 생략으로 RSS 절감.
 */
async function createCollectors(cfg: MonitorConfig): Promise<BaseCollector[]> {
  const list: BaseCollector[] = [];
  list.push(new SystemCollector(cfg));
  list.push(new HttpCollector(cfg));

  if (cfg.mqtt.brokers.length > 0) {
    const { MqttCollector } = await import('./collectors/mqtt.collector.js');
    list.push(new MqttCollector(cfg));
  }
  if (cfg.pm2.enabled) {
    const { Pm2Collector } = await import('./collectors/pm2.collector.js');
    list.push(new Pm2Collector(cfg));
  }
  if (cfg.databases.length > 0) {
    const { DatabaseCollector } = await import('./collectors/database.collector.js');
    list.push(new DatabaseCollector(cfg));
  }
  if (cfg.docker.enabled) {
    const { DockerCollector } = await import('./collectors/docker.collector.js');
    list.push(new DockerCollector(cfg));
  }
  if (cfg.ssl.domains.length > 0) {
    const { SslCollector } = await import('./collectors/ssl.collector.js');
    list.push(new SslCollector(cfg));
  }
  if (cfg.dns.checks.length > 0) {
    const { DnsCollector } = await import('./collectors/dns.collector.js');
    list.push(new DnsCollector(cfg));
  }
  if (cfg.logs.files.length > 0) {
    const { LogCollector } = await import('./collectors/log.collector.js');
    list.push(new LogCollector(cfg));
  }
  if (cfg.redis.instances.length > 0) {
    const { RedisCollector } = await import('./collectors/redis.collector.js');
    list.push(new RedisCollector(cfg));
  }
  if (cfg.queues.length > 0) {
    const { QueueCollector } = await import('./collectors/queue.collector.js');
    list.push(new QueueCollector(cfg));
  }
  if (cfg.hubWatch?.url) {
    const { HubWatchCollector } = await import('./collectors/hub-watch.collector.js');
    list.push(new HubWatchCollector(cfg));
  }
  if (cfg.frontend.buildDir || cfg.frontend.healthUrls.length > 0) {
    const { FrontendCollector } = await import('./collectors/frontend.collector.js');
    list.push(new FrontendCollector(cfg));
  }

  return list;
}

async function main(): Promise<void> {
  const config = loadMonitorConfig();
  const store = new EventStore(config.store);
  const emailSender = createEmailSender(config.email);
  const instantAlerts = new InstantAlertDispatcher(config, emailSender);
  const aggregator = new EventAggregator(store, instantAlerts);
  const reportBuilder = new ReportBuilder();

  const collectors = await createCollectors(config);
  for (const c of collectors) {
    const tick = () => {
      void aggregator.runCollector(c);
    };
    tick();
    setInterval(tick, c.intervalMs);
  }

  startCronSchedulers({ config, store, reportBuilder, emailSender });

  logger.info('daily digest monitor started', {
    collectors: collectors.map((c) => c.id),
    intervalMs: config.collectIntervalMs,
    instantAlerts: config.email.instantAlerts.enabled,
    instantMinSeverity: config.email.instantAlerts.minSeverity,
  });

  setImmediate(() => {
    void import('./startup/startup-notify.js')
      .then(({ sendStartupReportIfConfigured }) =>
        sendStartupReportIfConfigured({ config, store, emailSender }),
      )
      .catch((e) => logger.error('startup report error', { error: String(e) }));
  });

  const shutdown = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('fatal', { error: String(e) });
  process.exit(1);
});
