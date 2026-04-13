import 'dotenv/config';
import { loadMonitorConfig } from './config/monitor.config.js';
import { EventStore } from './aggregator/event.store.js';
import { EventAggregator } from './aggregator/event.aggregator.js';
import { ReportBuilder } from './report/report.builder.js';
import { createEmailSender } from './mailer/email.sender.js';
import { startCronSchedulers } from './scheduler/cron.scheduler.js';
import { logger } from './utils/logger.js';
import { SystemCollector } from './collectors/system.collector.js';
import { HttpCollector } from './collectors/http.collector.js';
import { MqttCollector } from './collectors/mqtt.collector.js';
import { Pm2Collector } from './collectors/pm2.collector.js';
import { DatabaseCollector } from './collectors/database.collector.js';
import { DockerCollector } from './collectors/docker.collector.js';
import { SslCollector } from './collectors/ssl.collector.js';
import { DnsCollector } from './collectors/dns.collector.js';
import { LogCollector } from './collectors/log.collector.js';
import { RedisCollector } from './collectors/redis.collector.js';
import { QueueCollector } from './collectors/queue.collector.js';
import { FrontendCollector } from './collectors/frontend.collector.js';
import type { BaseCollector } from './collectors/base.collector.js';
import type { MonitorConfig } from './types/monitor.types.js';

function createCollectors(cfg: MonitorConfig): BaseCollector[] {
  return [
    new SystemCollector(cfg),
    new HttpCollector(cfg),
    new MqttCollector(cfg),
    new Pm2Collector(cfg),
    new DatabaseCollector(cfg),
    new DockerCollector(cfg),
    new SslCollector(cfg),
    new DnsCollector(cfg),
    new LogCollector(cfg),
    new RedisCollector(cfg),
    new QueueCollector(cfg),
    new FrontendCollector(cfg),
  ];
}

function main(): void {
  const config = loadMonitorConfig();
  const store = new EventStore(config.store);
  const aggregator = new EventAggregator(store);
  const reportBuilder = new ReportBuilder();
  const emailSender = createEmailSender(config.email);

  const collectors = createCollectors(config);
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
  });

  const shutdown = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
