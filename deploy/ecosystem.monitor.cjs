/**
 * PM2로 모니터를 허브와 동일 Ubuntu 서버에서 상시 실행.
 *
 * 사전
 *   cp deploy/env.talktail-hub.example .env  # 필수 값 수정
 *   mkdir -p logs /home/ubuntu/monitor-data
 *   npm ci && npm run build
 *
 * 실행: pm2 start deploy/ecosystem.monitor.cjs
 * 로그: monitor/logs/
 *
 * 환경 변수는 monitor/.env (index.ts 에서 dotenv 로드, cwd=monitor).
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
