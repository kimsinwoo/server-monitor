/**
 * PM2로 모니터를 같은 실서버에서 상시 실행할 때 사용.
 * 사전: cd monitor && npm ci && npm run build
 * 실행: pm2 start deploy/ecosystem.monitor.cjs
 * 로그: monitor/logs/
 */
const path = require('path');

const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'daily-digest-monitor',
      cwd: root,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      error_file: path.join(root, 'logs/monitor-error.log'),
      out_file: path.join(root, 'logs/monitor-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
