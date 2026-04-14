import type { Category, MonitorEvent, Severity } from '../types/monitor.types.js';

/**
 * 이메일 본문용: 수집기·심각도·detail 기반 조치·원인 가설(규칙 기반, LLM 아님).
 */
export function analyzeMonitorEvent(event: MonitorEvent): string {
  const lines: string[] = [];
  const { category, severity, title, message, detail } = event;
  const d = detail && typeof detail === 'object' ? detail : {};

  const add = (s: string) => {
    const t = s.trim();
    if (t) lines.push(t);
  };

  add(`카테고리 \`${category}\`, 심각도 \`${severity}\`.`);
  add(`요약 제목: ${title}`);
  if (message) add(`수집기 메시지: ${message}`);

  switch (category as Category) {
    case 'http':
      add(
        'HTTP 점검: 브라우저/공인 URL과 동일 경로로 재현되는지, nginx·리버스 프록시 upstream 타임아웃·바디 크기 제한을 확인하세요.',
      );
      if (d.statusCode != null) add(`응답 코드 ${String(d.statusCode)} — 기대값과 비교해 애플리케이션·라우팅·인증을 점검하세요.`);
      if (d.responseTimeMs != null) add(`응답 시간 ${String(d.responseTimeMs)}ms — DB·외부 API·디스크 I/O 병목을 프로파일하세요.`);
      if (d.url) add(`대상 URL: ${String(d.url)}`);
      break;
    case 'mqtt':
      add('MQTT: 브로커 프로세스·방화벽·keepalive·클라이언트 ID 충돌·인증 정보를 확인하세요.');
      if (d.broker) add(`브로커: ${String(d.broker)}`);
      break;
    case 'pm2':
      add('PM2: 해당 프로세스 로그(pm2 logs), 재시작 원인(OOM·uncaught), 메모리·CPU 상한을 확인하세요.');
      if (d.processName) add(`프로세스: ${String(d.processName)}`);
      if (d.restartCount != null) add(`재시작 횟수: ${String(d.restartCount)}`);
      break;
    case 'system':
      add('시스템: 지속이면 스왑·디스크 여유·상위 CPU 프로세스·커널 로그(dmesg)를 확인하세요.');
      break;
    case 'database':
      add('DB: 커넥션 풀·슬로우 쿼리 로그·복제 지연·디스크·네트워크 레이턴시를 확인하세요.');
      break;
    case 'docker':
      add('Docker: 컨테이너 exit 코드·OOM·이미지 태그·볼륨·헬스체크를 확인하세요.');
      break;
    case 'ssl':
      add('SSL: 인증서 만료일·발급 CA·SNI·자동 갱신(cron/certbot)을 확인하세요.');
      break;
    case 'dns':
      add('DNS: 리졸버·방화벽·도메인 만료·예상 IP와 실제 응답 IP 일치 여부를 확인하세요.');
      break;
    case 'log':
      add('애플리케이션 로그: 동일 패턴 반복 여부, 배포 직후 회귀, 상위 스택 트레이스를 확인하세요.');
      if (d.logFile) add(`로그 파일: ${String(d.logFile)}`);
      if (d.matchedLine) add(`매칭 라인(일부): ${String(d.matchedLine).slice(0, 500)}`);
      break;
    case 'redis':
      add('Redis: maxmemory·eviction·복제·지속성(AOF/RDB) 설정과 메모리 사용 추이를 확인하세요.');
      break;
    case 'queue':
      add('큐/텔레메트리: 워커 프로세스 가동·소비자 수·적체 임계값·허브 API 토큰·네트워크를 확인하세요.');
      break;
    case 'frontend':
      add('프론트: 빌드 산출물·정적 경로·CSP·번들 크기·헬스 URL 응답을 확인하세요.');
      break;
    default:
      add('커스텀 수집기: detail JSON의 필드 정의에 맞춰 담당 서비스 로그와 메트릭을 대조하세요.');
  }

  if (severity === 'critical') {
    add('심각도 Critical: 즉시 온콜·롤백·트래픽 차단 등 가용한 가장 보수적인 완화 조치를 우선 검토하세요.');
  } else if (severity === 'error') {
    add('심각도 Error: 장애 등록 후 원인 범위(단일 노드 vs 전역)를 먼저 구분하세요.');
  } else if (severity === 'warning') {
    add('심각도 Warning: 당장 서비스 중단은 아닐 수 있으나, 동일 지표 추이를 모니터링하고 임계값·알림을 조정하세요.');
  }

  return lines.join('\n');
}

/** HTML `<li>` 목록용 이스케이프된 줄 단위 */
export function analysisToHtmlList(analysis: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`/g, '&#96;');
  const items = analysis
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (items.length === 0) return '<li style="margin:0 0 6px 0;">(분석 문구 없음)</li>';
  return items.map((l) => `<li style="margin:0 0 6px 0;line-height:1.5;">${esc(l)}</li>`).join('');
}

export function severityRank(s: Severity): number {
  switch (s) {
    case 'info':
      return 0;
    case 'warning':
      return 1;
    case 'error':
      return 2;
    case 'critical':
      return 3;
    default:
      return 0;
  }
}

export function meetsMinSeverity(eventSeverity: Severity, min: Severity): boolean {
  return severityRank(eventSeverity) >= severityRank(min);
}
