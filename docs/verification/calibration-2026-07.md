# Quality Gate 판정 정확도 캘리브레이션 스냅샷 (2026-07)

작성일: 2026-07-22
개정일: 2026-07-23 (5판 — 적대적 검증 F1·F2·F3 정정: AI 독립 재판정 산출 사실 반영(§3-1)·라벨 입력 UI 배선 상태 정정(§3)·8일 공백 서술을 표와 정합(§1-2). **정량 수치는 4판과 동일 — staleness 정정만, 수치 변경 없음**)
대상: `verifications` / `verification_issues` 누적 모수 258건 (`crewdeck` 프로젝트)
목적: evaluator 루브릭 수정의 **근거 데이터**를 남긴다. 루브릭·프롬프트 수정 자체는 이 문서 범위 밖이다.

---

## 데이터 규율 (이 문서의 인용 계약)

| 종류 | 유일한 출처 | 이 문서의 상태 |
|------|-------------|----------------|
| 수치(건수·비율·델타) | `/tmp/calibration-2026-07/metrics.md` (2026-07-22 21:43 KST 측정) | 아래 모든 숫자가 여기서만 왔다 |
| 사람 라벨(오탐·미탐) | `labels-human.md` 의 **사람 확정분** | 워크시트는 존재하나 **사람 판정 칸이 전부 비어 있다** → §3 전량 `미측정` |
| verification id (수치 아님) | 같은 읽기 전용 스냅샷에 대한 SELECT (§재현 명령 [id]) | §2·§4에 병기 |

- 추정·반올림 보정·서사적 보정을 하지 않는다. 근거가 없으면 `미측정` 으로 남긴다.
- `metrics.md` 에 없는 수치는 이 문서에 싣지 않는다. 3판에 있었으나 `metrics.md` 재측정본에 대응 값이 없는
  표(severity 어휘 분포, verdict별 정규화 보유율, hard-block 교차표)는 **의도적으로 뺐다**. 근거를 다시 만들면 복원한다.

### 3판 대비 정정 (수치가 아니라 해석의 오류였다)

3판은 배포 이후 신규 5건을 "08:58~10:31 생성 — 접지 커밋(11:07 KST)보다 **앞선다**" 고 적었다.
`verifications.created_at` 은 `datetime('now')` 기본값으로만 채워져 **저장값이 UTC** 이고
(`evaluator.ts` INSERT 문에 `created_at` 컬럼 없음), 스냅샷 사본의 `SELECT datetime('now')` 가
`2026-07-22 12:43:42` 인데 벽시계는 21:43 KST 로 +9h 차이가 실측 확인됐다.
즉 `08:58~10:31` 은 UTC(= 17:58~19:31 KST)라 접지 배포보다 **뒤**다. §1·§2는 UTC 기준으로 다시 나눈 결과다.

---

## 측정 방법

- 원본: `~/.crewdeck/crewdeck.db` (라이브 launchd 인스턴스).
- 접근: `db`/`db-wal`/`db-shm` 파일 복사 → 사본에서 `PRAGMA wal_checkpoint(TRUNCATE)` → 사본만 조회.
  **라이브 DB에 대한 write·스키마 변경·API 호출 0회.**
- 분류기: `server/core/quality-gate/fail-cause.ts` 의 `classifyFailCause` 를 재구현 없이 그대로 import 해 실행.
  입력 구성은 `GET /api/verifications/calibration` 라우트와 동일 — 정규화 `verification_issues` 우선,
  없는 행만 레거시 `verifications.issues` JSON blob 폴백.

---

## 1. 현재 fail률과 기준선 48% 대비 델타

| verdict | 건수 | 비율 |
|---------|------|------|
| fail | **121** | **46.9%** |
| pass | 120 | 46.5% |
| conditional | 17 | 6.6% |
| **합계** | **258** | **100%** |

| 항목 | 값 |
|------|-----|
| 기간 | 2026-07-09 23:05:31 ~ 2026-07-22 10:31:42 (UTC) |
| 대상 프로젝트 | `crewdeck`(`8fe0ef741d3b79de`) 1개 — 258건 전량, 다른 프로젝트 모수 없음 |
| 현재 fail률 | **46.9%** |
| 기준선 48% 대비 델타 | **-1.1%p** |

### 1-1. 접지 스프린트 배포(`efa1726`) 전/후 구간

경계 후보 두 개를 모두 확인했고 **그 사이에 생성된 verification 은 0건**이라 어느 쪽을 써도 분할이 같다.

| 경계 후보 | 값 (UTC) | 근거 |
|-----------|----------|------|
| 커밋 시각 `efa1726` | 2026-07-22 02:07:03 | `git show -s --format=%ci efa1726` (= 11:07:03 KST) |
| **실제 배포 재기동** | **2026-07-22 02:12:22** | `~/.crewdeck/logs/server.log` — 커밋 5분 뒤 첫 재기동 |

| 구간 | 총 | pass | conditional | fail | fail률 | 기준선 48% 대비 |
|------|-----|------|-------------|------|--------|-----------------|
| **이전** (~02:12:22Z) | 253 | 116 | 16 | 121 | **47.8%** | **-0.2%p** |
| **이후** (02:12:22Z~) | **5** | 4 | 1 | **0** | **0.0%** | **-48.0%p** |

이후 구간 5건 전량 (fail 0건):

| id | verdict | termination_reason | created_at (UTC) |
|----|---------|--------------------|------------------|
| `b19dc8ca6d26f6b0` | conditional | conditional | 2026-07-22 08:58:36 |
| `a6ea53d06b9cfc0a` | pass | passed | 2026-07-22 09:19:48 |
| `a535174158d5ab6b` | pass | passed | 2026-07-22 09:43:07 |
| `839feb8858dea881` | pass | passed | 2026-07-22 10:07:01 |
| `f7cb55029b52099c` | pass | passed | 2026-07-22 10:31:42 |

### 1-2. ⚠ -48.0%p 는 노이즈 구간이다 — 보정하지 않고 그대로 적는다

1. **표본 5건.** 이전 구간 fail률 47.8%가 참값이어도 5연속 non-fail 은 드물지 않다. 개입 효과의 증거로 쓸 수 없다.
2. **두 구간이 시간적으로 인접하지 않다.** 2026-07-14 09:08 ~ 2026-07-22 08:58 사이 유입이 0건(8일 공백)이고,
   그 사이 `efa1726` 말고도 여러 변경이 들어갔다 — 차이를 커밋 하나에 귀속시킬 수 없다.
3. **기준선 48%의 모수·기간이 미측정**이다(§4-0). 모르는 분모와의 델타는 부호까지 포함해 해석 불가다.

일자별 유입 (UTC):

| 일자 | 총 | fail |
|------|-----|------|
| 2026-07-09 | 7 | 4 |
| 2026-07-10 | 116 | 72 |
| 2026-07-11 | 81 | 34 |
| 2026-07-12 | 36 | 9 |
| 2026-07-13 | 5 | 0 |
| 2026-07-14 | 8 | 2 |
| 2026-07-15 ~ 07-21 | **0** | – |
| 2026-07-22 | 5 | 0 |

| 판정 | 값 |
|------|-----|
| 기준선 fail률 | 48% (`BASELINE_FAIL_RATE` 상수 — 모수·기간 **미측정**) |
| 전체 코퍼스 fail률 | 46.9% (258건) |
| 접지 배포 이후 fail률 | 0.0% (n=5) — **유효 신호 아님** |
| 유효 델타 | **미측정** |

→ 접지 효과 측정은 `efa1726` 이후 신규 verification 이 최소 30건 쌓인 뒤 재실행한다.

---

## 2. `classifyFailCause` 유형별 분포

분류 규칙 (구현 우선순위, `fail-cause.ts`):

1. `termination_reason == evaluator_error` → `evaluator_error`
2. `termination_reason == fix_round_limit` → `fix_round_limit`
3. 최고 severity issue 의 `dimension` (동점은 배열 첫 등장)
4. 위 어느 것도 없으면 → `unclassified`

`hard_blocked` 는 카테고리로 쓰지 않는다 — fail 의 `hard_blocked` 는 severity 의 재진술이고,
우선순위 상단에 두면 dimension 신호를 가진 행을 통째로 가린다 (`fail-cause.ts` 주석).
goal 블루프린트 Expected Tasks 의 서술과 **의도적으로 다른 지점**이다.

### 2-1. fail 121건 전량 (분모 = 121)

| 유형 | 건수 | 비율 |
|------|------|------|
| **unclassified** | **76** | **62.8%** |
| functionality | 24 | 19.8% |
| dataFlow | 12 | 9.9% |
| edgeCases | 4 | 3.3% |
| fix_round_limit | 3 | 2.5% |
| craft | 1 | 0.8% |
| designAlignment | 1 | 0.8% |
| **합계** | **121** | **100%** |

fail 121건의 `termination_reason` 원분포: `(null)` 105 / `hard_blocked` 13 / `fix_round_limit` 3.
`evaluator_error` 는 코퍼스에 0건이라, 규칙 1~2가 실제로 발화한 것은 `fix_round_limit` 3건뿐이다
(전량: `2ed17c862a25466b`, `0f912b8b0e873866`, `cbb04c1fb5e73d61`).

fail 121건이 전부 배포 이전 구간이므로 **이후 구간의 유형 분포는 모수 0으로 미측정**이다.

### 2-2. `unclassified` 62.8%는 "원인 불명"이 아니라 스키마 세대 아티팩트다

| 이슈 소스 | fail 건수 | 기간 (UTC) |
|-----------|-----------|------------|
| 정규화 `verification_issues` | 45 | 2026-07-11 07:20 ~ 2026-07-14 02:50 |
| 레거시 `verifications.issues` JSON | 76 | 2026-07-09 23:05 ~ 2026-07-10 20:23 |

레거시 blob 객체의 키를 전수 조사한 결과 = `id`, `severity`, `file`, `line`, `message`, `suggestion`.
**`dimension` 키가 아예 없다.** 76건은 데이터가 애매해서가 아니라 *dimension 을 담을 필드가 그 시절 스키마에 없어서*
구조적으로 100% `unclassified` 로 떨어진다. 폴백 경로의 유형 신호 복구율은 **0 / 76** 이다 — 행을 더 모아도 과거분은 복구되지 않는다.

대표 행 — 레거시 blob: `d181cdab5c455071`(2026-07-09 23:05:31), `2c31146378a6f87f`(23:16:09).
대표 행 — 정규화 보유: `3c0e25c7c6e620e4`(2026-07-11 07:20:16), `1ab097ff42f72012`(07:31:08).

### 2-3. 해석 가능한 표 — 정규화 레코드 보유 45건 (분모 = 45)

| 유형 | 건수 | 비율 |
|------|------|------|
| functionality | 24 | 53.3% |
| dataFlow | 12 | 26.7% |
| edgeCases | 4 | 8.9% |
| fix_round_limit | 3 | 6.7% |
| craft | 1 | 2.2% |
| designAlignment | 1 | 2.2% |

루브릭 논의는 §2-1(121 분모)이 아니라 **이 표를 근거로 한다**. 121 분모 표는 계측 배관의 상태를 보여줄 뿐이다.

---

## 3. 오탐/미탐 라벨 결과 — 전량 미측정

| 항목 | 값 |
|------|-----|
| 사람 확정 라벨 총계 | **미측정** (`labels-human.md` 워크시트는 존재, 사람 판정 칸 미기입) |
| 오탐 `false_positive` | **미측정** |
| 미탐 `false_negative` | **미측정** |
| `correct` | **미측정** |
| 대표 오탐 사례 | **미측정** |
| 대표 미탐 사례 | **미측정** |

라벨이 0건인 이유는 라벨러의 태만이 아니라 **라벨 입력 UI 는 배선됐으나(아래 상태표) 라이브에 미배포라 아직 사람이 라벨하지 않았기 때문**이다.

| 구성요소 | 상태 | 확인 방법 |
|----------|------|-----------|
| `classifyFailCause` | 구현 완료 | `server/core/quality-gate/fail-cause.ts` |
| `verification_labels` 테이블 | goal 브랜치에만 존재, **라이브 DB 미존재** | `metrics.md` §4 — 스냅샷에 테이블 없음 |
| `POST /api/verifications/:id/label` | goal 브랜치 구현, 미배포 | `server/api/routes/verification.ts` |
| `GET /api/verifications/calibration` | goal 브랜치 구현, 미배포 | 동상 |
| 집계 패널 `CalibrationPanel` | 구현 완료(빈 상태 포함), `ProjectHome` 에 배선됨 | `dashboard/src/components/CalibrationPanel.tsx` |
| **라벨 입력 UI** | **배선됨** — `VerificationLog.tsx:179` 이 `api.verifications.label()` 호출 + `InputDialog` + WebSocket `crewdeck:verification-labeled` 실시간 갱신. **라이브 미배포** | `grep -rn "\.label(" dashboard/src` → 1건 |

### 3-1. AI 독립 재판정(사람 확정 전) — 참고용 큐

표본 30건(fail 층화 20 + pass 무작위 10)에 대해 AI 독립 재판정을 수행해 `/tmp/calibration-2026-07/labels-ai.md` 로 산출했다.
**이것은 사람 라벨이 아니다.** 성격을 아래 계약으로 못박는다.

| 속성 | 값 |
|------|-----|
| provenance | `ai-adjudication` (전 행 명시) |
| `verification_labels` INSERT | **0건** — DB·게이트 무변경, Generator-Evaluator 분리 유지 |
| §3 본표(사람 확정) 합산 | **절대 금지** — §3 본표는 그대로 `미측정` |
| 용도 | 사람이 어느 행부터 열지 정하는 **검토 우선순위 큐** 뿐 |

> out-of-scope 조항이 금지하는 것은 AI 라벨을 `verification_labels`/판정 결과로 **승격**하는 것이다.
> 위 계약(0 INSERT·본표 미합산·게이트 무변경)을 지키는 참고용 큐는 그에 해당하지 않는다 — 실제로 사람 판정 칸은 여전히 비어 있다.

재판정 분포(참고용): fail 20건 중 **오탐후보 2건**(`0f8293129e261a9f`, `0e6364a115a8f1c8`) · 원판정동의 18건.
pass 관점 10건 중 **미탐후보 5건**(`1726e336277026bf`, `17fd591ebf6bdf14`, `1194cacb9d23a9c8`, `016edafbc7d60ac3`, `0f13272723ec4bf2`) · 정탐 5건.

기계 대조(`labels-human.md` §1 — 라이브 DB 사본 readonly + git object, write·API 0회): 정적으로 확인 가능한 주장은 **§2 방법론 요약 통계 1건을 제외하고 전부 원 데이터와 일치**했다. 반증된 그 1건("±180초 stash 21/30" → 자기 출처 실측 18/30)은 개별 오탐/미탐 판정에 영향이 없고 **이 문서는 그 수치를 인용하지 않는다**.

대표 사례 (모두 `ai-adjudication` 참고용, 사람 확정 아님):

- **오탐후보** `0f8293129e261a9f` / `0e6364a115a8f1c8` — `goal-as-unit.e2e.test.ts:1848` 의 stale assertion 으로 RED 인 것은 사실이나, 그 라인은 goal 브랜치 base(`64bbf38`)에 **이미 동일하게 존재**했고(이 goal 의 e2e hunk 에 미포함) 사이 fix round 는 3초 만에 코드 무변경 실패(순수 재탕) → "RED 는 참이나 이 태스크/goal 산출물과 무관한 선재 부채" 라는 오탐 논리가 기계적으로 재현됨.
- **미탐후보(사람 확인 우선순위 1위)** `1726e336277026bf` — 미배정 execute 경로가 실행 run 을 닫지 않아 유령 run 이 병합본(`13f94dae`)까지 흘러간 유일 건. `failExecutionRun` 호출부가 `engine.ts:2565`(decompose 실패 경로) 1곳뿐임을 기계 확인.

이 분포·사례는 **AI 재판정이며 사람 확정 라벨이 아니다.** 사람 판정이 AI 재판정과 달라도 사람 쪽이 정본이고, §3 본표는 사람이 `labels-human.md` 의 판정 칸을 채우기 전까지 `미측정` 으로 남는다.

### 3-2. 라벨 수집 절차 (라벨 UI 배선 완료 — 라이브 배포 후 실행)

- [ ] goal 브랜치를 main 에 병합하고 라이브를 drain 절차로 재시작 — `migrate()` 가 `verification_labels` 를 생성한다.
- [ ] `API_KEY=$(cat ~/.crewdeck/api-key)`
- [ ] fail 121건 중 표본을 대시보드에서 열어 오탐 라벨 — **§3-1 우선순위 큐(`1726e336…`·`0f8293…` 등)부터**. **DB 직접 INSERT 금지, 반드시 API 경유**.
- [ ] pass 120건 중 표본을 미탐 관점으로 라벨.
- [ ] 사람이 확정한 라벨을 `labels-human.md` 의 판정 칸에 채우고, 그 사람 확정분에서만 §3 표를 채운다.
- [ ] `GET /api/verifications/calibration?projectId=8fe0ef741d3b79de` 응답과 §3 표가 일치하는지 대조한다.

표본 크기는 통계적 유의성을 목표로 하지 않는다(과투자 금지 조항). fail/pass 각 20~30건이면 지배적 오탐 패턴은 드러난다.

---

## 4. 루브릭 수정 후보와 다음 goal 제안

아래는 **후보 목록**이다. `server/core/quality-gate/evaluator.ts` 의 판정 기준·프롬프트 수정은 이번 goal 범위 밖이며,
이 문서는 근거만 남긴다. 각 후보에는 근거 verification id 를 병기한다.

### 4-0. 선행 확인 — 기준선 48% 의 출처

`BASELINE_FAIL_RATE = 48` 은 goal 블루프린트가 전제로 준 값이고, **모수·기간·출처가 미측정**이다.
이 코퍼스 배포 이전 구간 253건의 47.8%와 반올림 일치하나 **정합 신호일 뿐 인과의 증거가 아니다**.
델타를 몇으로 계산하든 분모를 모르면 해석이 불가능하므로, 다음 goal 에서 기준선을 **모수·기간이 명시된 실측값으로 재정의**한다.

### 4-1. 라벨 없이도 확정된 근거 (§1·§2 실측에서 직접 도출)

| # | 후보 | 근거 (수치는 `metrics.md`) | 근거 verification id | 성격 |
|---|------|---------------------------|----------------------|------|
| A | 이슈 기록 경로를 정규화 `verification_issues` 로 일원화 | fail 121건 중 76건이 정규화 레코드 미보유(레거시 JSON 에만 존재) | `d181cdab5c455071`, `2c31146378a6f87f` (레거시) ↔ `3c0e25c7c6e620e4`, `1ab097ff42f72012` (정규화) | 계측 선행조건 |
| B | 이슈 저장 시 `dimension` 필수화 | 레거시 blob 키에 `dimension` 부재, 유형 복구율 **0 / 76** | `d181cdab5c455071`, `2c31146378a6f87f` | 계측 선행조건 |
| C | `termination_reason` 기록 누락 해소 | fail 121건 중 `(null)` 이 **105건** — 대다수가 종료 사유 미기록 | `d181cdab5c455071`, `2c31146378a6f87f` (null) ↔ `6f5b9ad049cfa207`, `65c12a475e75fdf9` (`hard_blocked` 기록됨) | 계측 선행조건 |
| D | 분류기에 dimension 외 보조 규칙 추가 | 레거시 폴백은 이미 있으나 dimension 이 0건이라 실효 없음 — 62.8%가 영구 사각지대 | `d181cdab5c455071`, `2c31146378a6f87f` | 분류기 설계 |
| E | `fix_round_limit` 종료 3건의 루브릭 적정성 검토 | 규칙 1~2 중 실제 발화한 유일한 경로. 정규화 45 분모에서 6.7% | `2ed17c862a25466b`, `0f912b8b0e873866`, `cbb04c1fb5e73d61` (전량) | 루브릭 후보 |

> A·B·C 는 **루브릭이 아니라 계측 배관** 문제다. 이걸 먼저 고치지 않으면 다음 코퍼스에서도
> `unclassified` 가 최빈값으로 남아 루브릭 논의 자체가 성립하지 않는다.

### 4-2. 라벨이 있어야 판단 가능한 후보 (현재 전부 미측정)

| # | 질문 | 필요한 데이터 |
|---|------|--------------|
| F | fail 46.9%는 과판정인가 정상인가 | fail 표본의 오탐 비율 |
| G | pass 120건에 숨은 미탐이 있는가 | pass 표본의 미탐 비율 |
| H | `functionality` 24건(정규화 분모 53.3%)이 최빈 실사유인가, 분류기 쏠림인가 | 그 24건의 오탐 비율 |
| I | 배포 이후 5건의 non-fail 이 실제 품질 개선인가 미탐인가 | `b19dc8ca6d26f6b0`, `a6ea53d06b9cfc0a`, `a535174158d5ab6b`, `839feb8858dea881`, `f7cb55029b52099c` 5건의 사람 판독 |

### 4-3. 다음 goal 제안 (우선순위 순)

1. **라벨 입력 UI 라이브 배포** — UI 배선은 완료(`VerificationLog.tsx:179`). 남은 일 = 이 goal 브랜치를 라이브에 배포 + 사람 라벨 수집.
   배포 전까지는 curl 로만 라벨할 수 있고, 그때까지 §3 은 미측정으로 남는다. (근거: §3 상태표)
2. **이슈 기록 정규화 강제** (후보 A·B·C) — evaluator 가 이슈를 남길 때 `dimension` 없이는 저장 불가하게 하고
   `termination_reason` 을 항상 기록한다. 루브릭 *기준*이 아니라 *출력 스키마* 변경이라 out-of-scope 의
   "판정 기준 변경"에 해당하지 않는다. (근거: `d181cdab5c455071`, `2c31146378a6f87f`)
3. **`efa1726` 이후 신규 30건 축적 후 §1 재측정 + 기준선 재정의** — `BASELINE_FAIL_RATE` 를 출처 불명 상수로
   두지 않고 모수·기간이 명시된 실측값으로 고정한다. (근거: §4-0, 이후 구간 5건)
4. **사람 라벨 40~60건 수집 후 §3·§4-2 확정** — 여기까지 와야 루브릭 수정이 근거를 갖는다.
5. **`fix_round_limit` 3건 판독** — 표본이 작아 사람 판독 비용이 가장 싸다. (근거: `2ed17c862a25466b`,
   `0f912b8b0e873866`, `cbb04c1fb5e73d61`)

---

## 재현 명령

```bash
# 0. 읽기 전용 사본 (라이브 DB 에는 쓰지 않는다)
mkdir -p /tmp/calibration-2026-07
cp ~/.crewdeck/crewdeck.db     /tmp/calibration-2026-07/db.snapshot
cp ~/.crewdeck/crewdeck.db-wal /tmp/calibration-2026-07/db.snapshot-wal
cp ~/.crewdeck/crewdeck.db-shm /tmp/calibration-2026-07/db.snapshot-shm
sqlite3 /tmp/calibration-2026-07/db.snapshot "PRAGMA wal_checkpoint(TRUNCATE);"
S=/tmp/calibration-2026-07/db.snapshot

# §1·§2 수치 전량 — 분류기를 재구현하지 않고 import 해 실행한다
cd /Users/keunsik/develop/givepro91/crewdeck && ./node_modules/.bin/tsx /tmp/calibration-2026-07/measure.ts
# 실행한 SQL 원문과 출력은 /tmp/calibration-2026-07/metrics.md §5 에 그대로 있다

# §1-1 배포 경계 근거
git show -s --format='%ci' efa1726
grep -n "Terminal auto-advance started" ~/.crewdeck/logs/server.log | tail -12

# [id] §2·§4 에 병기한 대표 verification id (수치가 아니라 식별자만 뽑는다)
sqlite3 -header -column "file:$S?mode=ro" "
SELECT v.id, v.severity, COALESCE(v.termination_reason,'(null)') tr, v.created_at
FROM verifications v WHERE v.verdict='fail'
  AND NOT EXISTS(SELECT 1 FROM verification_issues i WHERE i.verification_id=v.id)
ORDER BY v.created_at LIMIT 2;"                       # 레거시 blob 대표
sqlite3 -header -column "file:$S?mode=ro" "
SELECT v.id, v.severity, COALESCE(v.termination_reason,'(null)') tr, v.created_at
FROM verifications v WHERE v.verdict='fail'
  AND EXISTS(SELECT 1 FROM verification_issues i WHERE i.verification_id=v.id)
ORDER BY v.created_at LIMIT 2;"                       # 정규화 대표
sqlite3 -header -column "file:$S?mode=ro" "
SELECT id, severity, created_at FROM verifications
WHERE verdict='fail' AND termination_reason='fix_round_limit' ORDER BY created_at;"   # 전량 3건
sqlite3 -header -column "file:$S?mode=ro" "
SELECT id, severity, created_at FROM verifications
WHERE verdict='fail' AND termination_reason='hard_blocked' ORDER BY created_at LIMIT 2;"

# §3 라벨 입력 UI 배선 확인 (호출부 1건 = 배선됨: VerificationLog.tsx:179 — 단, 라이브 미배포)
grep -rn "\.label(" dashboard/src

# Generator-Evaluator 분리 유지 확인 (0건이어야 함)
grep -rn "verification_labels" server/core/quality-gate/

# 배포 이후에는 같은 수치를 API 로 직접 받을 수 있다
API_KEY=$(cat ~/.crewdeck/api-key)
curl -s -H "Authorization: Bearer $API_KEY" \
  'http://127.0.0.1:7200/api/verifications/calibration?projectId=8fe0ef741d3b79de' | jq
```

---

## 제약 / 알려진 비검증 항목

- 라이브 DB **write 는 수행하지 않았다**. 모든 수치는 읽기 전용 사본에 대한 SELECT 와 순수 함수 실행 결과다.
- **사람 확정 오탐/미탐 라벨은 전부 미측정**이다. `labels-human.md` 워크시트는 존재하나 사람 판정 칸이 전부 비어 있다. AI 독립 재판정(`labels-ai.md`, provenance `ai-adjudication`)은 수행했으나 §3 본표에 합산하지 않는다(§3-1).
- **기준선 48%의 모수·기간은 미측정**이다. 따라서 §1 의 델타 -1.1%p 는 부호까지 포함해 신뢰하지 않는 것이 맞다(§4-0).
- 접지 스프린트 이후 fail률 0.0%는 **n=5** 다. 개입 효과의 증거가 아니고, 두 구간 사이에 8일 공백이 있다(§1-2).
- 배포 이후 구간의 **fail 유형 분포는 모수 0건으로 미측정**이다.
- §2 표는 goal 블루프린트 Expected Tasks 의 서술과 **의도적으로 다르다** — `hard_blocked` 를 유형에서 제외했다(§2 규칙).
- `GET /api/verifications/calibration` **엔드포인트 응답으로는 관통 확인하지 않았다**. 라이브에 미배포이고,
  별도 인스턴스는 데이터가 비어 있어 같은 모수를 재현할 수 없다. §2 수치는 라우트와 동일한 입력 구성으로
  `classifyFailCause` 를 직접 실행해 얻었다.
- 모수 258건이 **전량 `crewdeck` 자기 자신의 goal 실행에서 나온 판정**이다. 외부 프로젝트 판정 0건 —
  다른 코드베이스로 일반화할 수 없고 `?projectId=` 스코프 분기도 실데이터로는 검증되지 않았다.
- 이슈 본문의 정성 품질(evidence·repro_command 가 실제로 재현되는지)은 표본 판독을 하지 않아 미검증이다.
- 3판에 있던 severity 어휘 드리프트 표·verdict별 정규화 보유율·hard-block 교차표는 `metrics.md` 재측정본에
  대응 값이 없어 이 판에서 뺐다(§데이터 규율). 필요하면 근거를 다시 측정해 복원한다.
