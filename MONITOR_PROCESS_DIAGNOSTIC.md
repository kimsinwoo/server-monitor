# Monitor 단독 프로세스 — 진단용 패키지 (업로드·공유용)

다른 분(메모리 누수 진단 등)께 **그대로 붙여넣기**할 수 있도록 정리했습니다.

**이 문서에서 지적한 항목 중 코드로 반영된 것:**  
`InstantAlertDispatcher` 쿨다운 Map 상한·오래된 키 정리, `index.ts`에서 `clearInterval` + cron `stop()` on shutdown, JSON 스토어를 **일별 `.jsonl` 샤드 append**로 변경(구 단일 `.json`은 시작 시 샤드로 이전 후 `.migrated.bak`).

---

## 1. 프로세스가 두 종류일 수 있음 (혼동 방지)

| 구분 | 역할 | 실행 방식 |
|------|------|-----------|
| **일간 다이제스트 Monitor** | 수집기 루프 + SQLite 이벤트 저장 + 크론 리포트/즉시 알림 | `npm run build` 후 `node dist/index.js` 또는 PM2 `deploy/ecosystem.monitor.cjs` |
| **`sendRecordingCloseMail.cjs`** | 허브가 **녹음 종료 시** `require`하는 **메일 스크립트만** | 허브(Node) 프로세스 **안에서** 로드됨. **monitor 단독 프로세스가 아님** |

**106MB + 미세 증가**가 **PM2 이름이 `daily-digest-monitor` 등**인 프로세스라면, 아래 `index.ts` / 수집기 쪽을 봐야 합니다.  
같은 증상이 **허브 프로세스**라면 `sendRecordingCloseMail.cjs`는 **한 번 로드 후 require 캐시**라 반복 증가의 주원인은 보통 아닙니다.

---

## 2. 메인 진입점 (필수)

| 항목 | 경로 |
|------|------|
| 소스 진입점 | `monitor/src/index.ts` |
| 빌드 후 진입점 | `monitor/dist/index.js` (package.json `start`) |
| PM2 설정 | `monitor/deploy/ecosystem.monitor.cjs` — `script: dist/index.js`, `cwd: monitor 루트` |

`package.json` 스크립트:

- `"start": "node dist/index.js"`
- `"dev": "node --import tsx src/index.ts"`

---

## 3. `package.json` 요약 (의존성)

이름: `server-daily-digest-monitor`, `type: "module"`, Node `>=20`.

주요 `dependencies`: `axios`, `better-sqlite3`, `chokidar`, `dockerode`, `dotenv`, `ioredis`, `mqtt`, `node-cron`, `nodemailer`, `pm2`, `systeminformation`, `uuid`, `winston`.

선택: `mysql2`, `pg`.

---

## 4. 타이머 / 주기 실행 (누수 진단용)

### 4.1 `setInterval` — **수집기마다 1개** (종료 시 정리 없음)

**파일:** `monitor/src/index.ts`

각 활성 수집기 `c`에 대해:

1. 즉시 1회 `tick()` → `aggregator.runCollector(c)`
2. `setInterval(tick, c.intervalMs)` — **타이머 ID를 배열에 저장**, 종료 시 `clearInterval`
3. `SIGINT` / `SIGTERM` 시 **interval 정리 + cron `stop()`** 후 `store.close()` → `process.exit(0)`

일반적인 **장기 단일 실행**에서도 **graceful shutdown / PM2 reload** 시 타이머·크론이 남지 않도록 정리합니다.

### 4.2 `node-cron` — 일 2회

**파일:** `monitor/src/scheduler/cron.scheduler.ts`

- `0 0 * * *` — 전일 이벤트 일간 리포트 메일
- `0 1 * * *` — `store.purgeOlderThanDays`

`startCronSchedulers`가 **`stop()`** 을 반환해, 종료 시 두 작업 모두 `ScheduledTask.stop()` 호출.

### 4.3 그 외 `setTimeout`

- `monitor/src/aggregator/event.store.ts` — `appendEvent` 재시도 시 짧은 `setTimeout` (일시적)
- `monitor/src/collectors/mqtt.collector.ts` — 연결 시도당 `setTimeout` + `clearTimeout` (수집 주기마다 새 클라이언트 생성 후 `end`)

### 4.4 `chokidar`

`package.json`에 포함되어 있으나, **`monitor/src` 아래에서는 tail/watch용 import를 사용하지 않음** (로그 수집은 `LogCollector`가 **주기적으로 파일 offset 읽기**).

---

## 5. 메모리·누수 후보 (코드 리뷰 기준) — 일부 완화됨

| 우선순위 | 위치 | 내용 |
|----------|------|------|
| ~~높음~~ 완화 | `instant-alert.dispatcher.ts` | 쿨다운 Map에 **오래된 키 삭제 + 최대 5000개** 상한(배치마다 `pruneCooldownMap`). |
| ~~중간~~ 완화 | `event.store.ts` + `STORE_TYPE=json` | **일별 `YYYY-MM-DD.jsonl`에 한 줄 append** — 구 단일 `*.json`은 마이그레이션 후 `.migrated.bak`. sqlite 모드는 변경 없음. |
| **중간** | `log.collector.ts` | 로그 파일이 **짧은 시간에 크게 증가**하면 `toRead`만큼 **한 틱에 큰 Buffer/문자열** 할당 (틱 끝에 GC 대상). 누수라기보다 **스파이크**. |
| **낮음** | `mqtt.collector.ts` | 매 `collect()`마다 `mqtt.connect` — 누수보다는 **부하/소켓** 이슈 가능. |
| ~~낮음~~ 완화 | `index.ts` `setInterval` | 종료 시 **clearInterval** + cron **stop**. |

---

## 6. `monitor/` 소스 트리 (node_modules·dist 제외, 상위 나열)

```
monitor/package.json
monitor/package-lock.json
monitor/sendRecordingCloseMail.cjs
monitor/tsconfig.json
monitor/vitest.config.ts
monitor/deploy/ecosystem.monitor.cjs
monitor/src/index.ts
monitor/src/scheduler/cron.scheduler.ts
monitor/src/config/monitor.config.ts
monitor/src/config/thresholds.ts
monitor/src/aggregator/event.store.ts
monitor/src/aggregator/event.aggregator.ts
monitor/src/aggregator/instant-alert.dispatcher.ts
monitor/src/collectors/*.ts
monitor/src/mailer/email.sender.ts
monitor/src/report/*
monitor/src/startup/startup-notify.ts
monitor/src/utils/*.ts
monitor/src/types/monitor.types.ts
```

빌드 산출물: `monitor/dist/index.js` 및 `dist/**` (배포 시 이쪽 실행).

---

## 7. 외부에 넘길 때 첨부 권장 파일

1. `monitor/src/index.ts`
2. `monitor/package.json`
3. `monitor/src/scheduler/cron.scheduler.ts`
4. `monitor/src/aggregator/instant-alert.dispatcher.ts`
5. `monitor/src/aggregator/event.store.ts`
6. `monitor/src/collectors/log.collector.ts`
7. `monitor/src/collectors/mqtt.collector.ts`
8. `monitor/deploy/ecosystem.monitor.cjs`
9. (선택) 실제 `.env` 또는 **민감값 제거한** 설정 스냅샷 — `STORE_TYPE`, `collectIntervalMs`, 수집기 활성 목록

---

## 8. 터미널 `find` 예시 (로컬에서 복사해 쓰기)

```bash
cd /path/to/talktailForPet
find monitor -type f \( -name "*.js" -o -name "*.cjs" -o -name "*.ts" \) \
  ! -path "*/node_modules/*" ! -path "*/dist/*" | sort | head -80
```

---

이 문서는 레포 내 `monitor/MONITOR_PROCESS_DIAGNOSTIC.md`에 저장되어 있습니다.
