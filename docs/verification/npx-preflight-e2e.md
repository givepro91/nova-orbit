# npx 첫 실행 Preflight E2E Quality Gate

작성일: 2026-07-11
대상: `npx crewdeck` 첫 실행, preflight 진단, 복구 UX, dashboard smoke

## 최종 판정

**FAIL** — preflight 개별 시나리오와 로컬 `dist` dashboard smoke는 통과했지만, 실제 npm tarball을 빈 디렉터리에서 `npx`로 설치하는 기준 경로가 CLI preflight 진입 전에 실패한다.

차단 원인:

- 배포 tarball은 `package.json#files`에 따라 `dist/`, `templates/`, `README.md`, `LICENSE`만 포함한다.
- 루트 `postinstall` 스크립트는 `cd dashboard && npm install`을 실행한다.
- tarball에 루트 `dashboard/` 디렉터리가 없으므로 `crewdeck@0.1.0 postinstall` 이 exit 1로 종료한다.
- 결과적으로 `npx crewdeck` 프로세스가 시작되지 않아, 깨끗한 환경에서는 원인·선택 근거·복구 명령을 preflight UX로 제공하지 못한다.

Quality Gate를 PASS로 바꾸려면 패키지 설치 스크립트를 배포 구조와 맞춘 뒤, 아래 `npm pack → 빈 cwd → npx → health/dashboard` 경로를 다시 통과해야 한다.

---

## 검증 계약

성공 환경은 다음을 모두 만족해야 한다.

1. 빈 cwd와 격리 npm cache에서 현재 tarball을 `npx` 설치·실행한다.
2. 모든 필수 check가 `PASS`이고 선택된 data directory 근거가 표시된다.
3. `/api/health`, dashboard `/`, dashboard JS asset이 모두 HTTP 200이다.
4. 검증 스크립트가 시작한 자신의 PID만 `TERM`으로 정리한다.

실패 환경은 다음을 모두 만족해야 한다.

1. 해당 check가 `FAIL`이고 프로세스 종료 코드는 non-zero이다.
2. 한 번의 실행 출력에 check ID, 원인, 현재 선택 근거, 복구 명령이 함께 보인다.
3. `crewdeck.db`, `crewdeck.db-wal`, `crewdeck.db-shm`, `api-key`, `server.pid`가 생기지 않는다.
4. data-directory check가 생성 가능성을 확인하기 위해 누락 선택 디렉터리나 자동 fallback 후보를 생성할 수는 있지만, 내부 write probe는 반드시 정리되어 빈 디렉터리로 남아야 한다.
5. 파일·읽기 전용 대상, 점유 포트, `better-sqlite3` binary, 기존 프로세스를 수정하거나 종료하지 않는다.

---

## 안전 전제

- `npm run dev`, `npm start`, `scripts/service-macos.sh`, `predev.sh`, `launchctl`, 고정 포트 7200을 사용하지 않는다.
- 생성 가능한 data fixture·npm cache·cwd를 `mktemp -d` 아래에 격리한다. 읽기 전용 대상은 변경되지 않는 macOS `/System` 경로를 예외로 사용한다. data-path 실패 시나리오는 자동 fallback 후보 `~/.crewdeck-fallback`도 실제 home에 남지 않도록 `HOME` 자체를 임시 경로로 격리한다.
- 포트는 loopback에 `listen(0)`으로 배정받는다.
- 점유 포트 시나리오는 검증용 listener를 새로 띄우고 그 PID만 정리한다.
- ABI 시나리오에서 출력된 `npm rebuild`/`npm install --force`는 공유 워크트리에서 실행하지 않는다. 복구 명령의 존재와 install root 범위만 검증한다.
- provider 인증 원문은 이메일·조직·token을 포함할 수 있으므로 증거 로그에 복사하지 않는다.

---

## 실행 환경

2026-07-11 실측:

- macOS arm64, Darwin 25.5.0
- Node.js 26.0.0, npm 11.12.1
- 빌드 tarball: `crewdeck-0.1.0.tgz`
- Node 경계 재현: `npx -y node@18`, `npx -y node@20`
- 정상 provider: Claude, Codex 모두 설치·인증됨. 인증 세부 값은 기록하지 않음.

---

## 결과 매트릭스

| 시나리오 | 실행 방식 | 핵심 증거 | 판정 |
|---|---|---|---|
| 깨끗한 `npx` 설치 | `npm pack` 후 빈 cwd·빈 npm cache에서 tarball `npx` | `crewdeck@0.1.0 postinstall` exit 1, CLI 출력 0건, data artifact 0개 | **FAIL** |
| Node < 20 | Node 18.20.8로 built CLI 실행 | `[node] FAIL`, exit 1, data dir 미생성, `nvm install/use 20` + 재실행 안내 | PASS |
| ABI 불일치 | Node 26으로 build된 binding을 Node 20.20.2에서 probe | `[sqlite] FAIL`, `NODE_MODULE_VERSION 147 → 115`, exit 1, binding checksum 불변 | PASS |
| 생성 가능 data path | 존재하지 않는 `mktemp` 하위 경로 | `[data-directory] PASS`, probe 정리, 정상 시 DB·key·PID 생성 | PASS |
| data path가 파일 | sentinel 파일을 `--data-dir` 지정 | `[data-directory] FAIL`, exit 1, sentinel checksum 불변, 임시 home의 빈 fallback 후보·복구 명령 | PASS |
| 읽기 전용 data path | macOS `/System/crewdeck-preflight-quality-gate` | `EPERM` 원인, exit 1, 대상 미생성, 임시 home의 빈 fallback 후보·복구 명령 | PASS |
| 점유 포트 | 임시 loopback listener로 동적 포트 점유 | `[port] FAIL`, exit 1, 다음 bind 가능 포트 재실행 명령, listener 생존, data artifact 0개 | PASS |
| CLI 미설치 | child `PATH=/usr/bin:/bin` | Claude/Codex 모두 `ENOENT`, exit 1, 설치·로그인·동일 인자 재실행 안내 | PASS |
| CLI 미인증 | 임시 `PATH`의 `claude`, `codex`를 `/usr/bin/false`로 교체 | 둘 다 auth status exit 1, raw auth 출력 미노출, data artifact 0개 | PASS |
| fallback | selected Claude만 실패, 실제 authenticated Codex는 유지 | `[provider-cli] WARN`, `claude → codex fallback` 선택 근거, health 200 | PASS |
| 로컬 `dist` 정상 smoke | 임시 data dir + 동적 포트 + `--no-open` | health 200, dashboard HTML 200, JS asset 200 | PASS |

---

## 재현 절차

### 1. 깨끗한 tarball + npx 기준 경로

루트에서 전체 build를 먼저 수행한다. `build:server` 단독 실행은 금지한다.

```bash
npm run build

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-npx-clean.XXXXXX")
mkdir "$ROOT/package" "$ROOT/empty-cwd" "$ROOT/data" "$ROOT/npm-cache"
PACK_JSON=$(npm pack --ignore-scripts --json --pack-destination="$ROOT/package")
TARBALL="$ROOT/package/$(printf '%s' "$PACK_JSON" | jq -r '.[0].filename')"
PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

cd "$ROOT/empty-cwd"
set +e
npm_config_cache="$ROOT/npm-cache" \
  npx --yes --package="$TARBALL" -- \
  crewdeck --data-dir="$ROOT/data" --port="$PORT" --no-open \
  >"$ROOT/out.log" 2>&1
STATUS=$?
set -e

test "$STATUS" -ne 0
test "$(find "$ROOT/data" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
DEBUG_LOG=$(find "$ROOT/npm-cache/_logs" -type f -name '*-debug-0.log' -print -quit)
grep -F 'crewdeck@0.1.0 postinstall' "$DEBUG_LOG"
```

현재 결과는 CLI banner 전에 exit 1이다. npm debug log의 결정적 행:

```text
info run better-sqlite3@12.11.1 install { code: 0, signal: null }
info run crewdeck@0.1.0 postinstall node_modules/crewdeck cd dashboard && npm install
info run crewdeck@0.1.0 postinstall { code: 1, signal: null }
```

실패 직후 `$ROOT/data` 아래 artifact는 0개다. 즉 Crewdeck 초기화 부작용은 없지만, npm cache의 임시 설치는 실패 흔적으로 남는다. 검증 끝에 `$ROOT`를 전체 삭제한다.

### 2. Node < 20

```bash
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-node18.XXXXXX")
PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
set +e
npx -y node@18 dist/bin/crewdeck.js \
  --data-dir="$ROOT/data" --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e

test "$STATUS" -ne 0
test ! -e "$ROOT/data"
grep -F '[node]' "$ROOT/out.log"
grep -F 'nvm install 20' "$ROOT/out.log"
grep -F 'nvm use 20' "$ROOT/out.log"
! grep -F '[sqlite]' "$ROOT/out.log"
! grep -F '[data-directory]' "$ROOT/out.log"
```

Node 실패는 `haltChain` 경계다. `[sqlite]`, data-directory, port, provider check가 실행되면 FAIL로 판정한다.

### 3. better-sqlite3 ABI 불일치

현재 Node로 네이티브 binding이 build된 후, 지원 범위 내의 다른 Node 메이저로 CLI를 실행한다. 이 문서 실측은 Node 26 binding을 Node 20에서 로드했다.

```bash
BINDING=$(node -e 'const p=require("node:path");console.log(p.resolve(p.dirname(require.resolve("better-sqlite3")),"../build/Release/better_sqlite3.node"))')
BEFORE=$(shasum -a 256 "$BINDING" | awk '{print $1}')
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-abi.XXXXXX")
PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

set +e
npx -y node@20 dist/bin/crewdeck.js \
  --data-dir="$ROOT/data" --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e

AFTER=$(shasum -a 256 "$BINDING" | awk '{print $1}')
test "$STATUS" -ne 0
test "$BEFORE" = "$AFTER"
test "$(find "$ROOT/data" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
grep -F '[sqlite]' "$ROOT/out.log"
grep -F 'npm rebuild better-sqlite3 --prefix' "$ROOT/out.log"
grep -F 'npm install --force better-sqlite3 --prefix' "$ROOT/out.log"
```

ABI 실패 후에도 runner는 독립적인 후속 check를 수행하므로 data directory는 생성될 수 있다. 디렉터리 자체를 부작용으로 판정하지 않되, DB·key·PID·probe가 하나라도 남으면 FAIL이다.

### 4. data path 경계

파일 경로:

```bash
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-data-file.XXXXXX")
NODE=$(command -v node)
mkdir -p "$ROOT/home/.crewdeck" "$ROOT/bin"
printf '{"defaultProvider":"codex","codexFailover":true}\n' >"$ROOT/home/.crewdeck/config.json"
ln -s /usr/bin/true "$ROOT/bin/codex"
ln -s /usr/bin/true "$ROOT/bin/claude"
printf 'sentinel\n' >"$ROOT/not-a-directory"
BEFORE=$(shasum -a 256 "$ROOT/not-a-directory" | awk '{print $1}')
PORT=$($NODE -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

set +e
env HOME="$ROOT/home" PATH="$ROOT/bin" "$NODE" dist/bin/crewdeck.js --data-dir="$ROOT/not-a-directory" \
  --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e

AFTER=$(shasum -a 256 "$ROOT/not-a-directory" | awk '{print $1}')
test "$STATUS" -ne 0
test "$BEFORE" = "$AFTER"
test -d "$ROOT/home/.crewdeck-fallback"
test "$(find "$ROOT/home/.crewdeck-fallback" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
grep -F '경로가 디렉터리가 아니라 파일입니다' "$ROOT/out.log"
grep -F 'npx crewdeck --data-dir=' "$ROOT/out.log"
grep -F "$ROOT/home/.crewdeck-fallback" "$ROOT/out.log"
```

macOS 읽기 전용 경로:

```bash
TARGET=/System/crewdeck-preflight-quality-gate
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-data-readonly.XXXXXX")
NODE=$(command -v node)
mkdir -p "$ROOT/home/.crewdeck" "$ROOT/bin"
printf '{"defaultProvider":"codex","codexFailover":true}\n' >"$ROOT/home/.crewdeck/config.json"
ln -s /usr/bin/true "$ROOT/bin/codex"
ln -s /usr/bin/true "$ROOT/bin/claude"
PORT=$($NODE -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
set +e
env HOME="$ROOT/home" PATH="$ROOT/bin" "$NODE" dist/bin/crewdeck.js --data-dir="$TARGET" \
  --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e

test "$STATUS" -ne 0
test ! -e "$TARGET"
test -d "$ROOT/home/.crewdeck-fallback"
test "$(find "$ROOT/home/.crewdeck-fallback" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
grep -E 'EPERM|EACCES|read-only' "$ROOT/out.log"
grep -F 'npx crewdeck --data-dir=' "$ROOT/out.log"
grep -F "$ROOT/home/.crewdeck-fallback" "$ROOT/out.log"
```

Linux에서는 실행자가 쓰기 불가능한 격리 fixture를 사용한다. root로 `chmod` 경계를 검증하면 권한을 우회할 수 있으므로 테스트 증거로 인정하지 않는다.

### 5. 점유 포트

```bash
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-port.XXXXXX")
mkdir "$ROOT/data"
PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node -e 'require("node:net").createServer().listen(Number(process.argv[1]),"127.0.0.1")' "$PORT" &
OCCUPIER=$!
cleanup_port_fixture() {
  if kill -0 "$OCCUPIER" 2>/dev/null; then kill -TERM "$OCCUPIER"; fi
  wait "$OCCUPIER" 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup_port_fixture EXIT

set +e
node dist/bin/crewdeck.js --data-dir="$ROOT/data" \
  --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e

test "$STATUS" -ne 0
kill -0 "$OCCUPIER"
test "$(find "$ROOT/data" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
grep -F '[port]' "$ROOT/out.log"
grep -F 'npx crewdeck' "$ROOT/out.log"
cleanup_port_fixture
trap - EXIT
```

점유자를 종료하라는 복구 명령이 아니라, bind 가능을 probe한 다른 포트와 현재 `--data-dir`를 보존한 재실행 명령이 나와야 한다.

### 6. provider 미설치·미인증·fallback

미설치는 Crewdeck 프로세스만 절대 경로의 Node로 실행하고 child `PATH`에서 두 CLI를 제거해 재현한다.

```bash
NODE=$(command -v node)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-provider-missing.XXXXXX")
mkdir "$ROOT/data"
PORT=$($NODE -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
set +e
env PATH=/usr/bin:/bin "$NODE" dist/bin/crewdeck.js \
  --data-dir="$ROOT/data" --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e
test "$STATUS" -ne 0
test "$(find "$ROOT/data" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
grep -F '[provider-cli]' "$ROOT/out.log"
grep -F 'npm install -g @anthropic-ai/claude-code' "$ROOT/out.log"
grep -F 'claude login' "$ROOT/out.log"
```

미인증은 실제 credential을 수정하지 않고 임시 `PATH` fixture로 재현한다.

```bash
NODE=$(command -v node)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-provider-auth.XXXXXX")
mkdir "$ROOT/bin" "$ROOT/data"
PORT=$($NODE -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
ln -s /usr/bin/false "$ROOT/bin/claude"
ln -s /usr/bin/false "$ROOT/bin/codex"
set +e
env PATH="$ROOT/bin" "$NODE" dist/bin/crewdeck.js \
  --data-dir="$ROOT/data" --port="$PORT" --no-open >"$ROOT/out.log" 2>&1
STATUS=$?
set -e
test "$STATUS" -ne 0
test "$(find "$ROOT/data" -mindepth 1 -maxdepth 1 | wc -l)" -eq 0
grep -F '인증 상태 확인이 종료 코드 1로 실패했습니다' "$ROOT/out.log"
grep -F 'claude login' "$ROOT/out.log"
```

fallback은 selected provider만 실패시키고 대체 provider의 실제 인증을 사용한다. 아래는 글로벌 기본값이 Claude이고 Codex가 인증된 환경의 예시다.

```bash
NODE=$(command -v node)
CODEX=$(command -v codex)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-provider-fallback.XXXXXX")
mkdir "$ROOT/bin" "$ROOT/data"
PORT=$($NODE -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
ln -s /usr/bin/false "$ROOT/bin/claude"
ln -s "$CODEX" "$ROOT/bin/codex"
ln -s "$NODE" "$ROOT/bin/node"

env PATH="$ROOT/bin" "$NODE" dist/bin/crewdeck.js \
  --data-dir="$ROOT/data" --port="$PORT" --no-open >"$ROOT/out.log" 2>&1 &
PID=$!
cleanup_fallback_fixture() {
  if kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID"; fi
  wait "$PID" 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup_fallback_fixture EXIT

ATTEMPT=0
until curl -fsS "http://127.0.0.1:$PORT/api/health" >"$ROOT/health.json" 2>/dev/null; do
  ATTEMPT=$((ATTEMPT + 1))
  if ! kill -0 "$PID" 2>/dev/null || test "$ATTEMPT" -ge 300; then
    sed -n '1,200p' "$ROOT/out.log"
    exit 1
  fi
  sleep 0.1
done

grep -F '[provider-cli]' "$ROOT/out.log"
grep -F 'codex fallback 경로로 시작합니다' "$ROOT/out.log"
cleanup_fallback_fixture
trap - EXIT
```

fallback PASS 증거는 `[provider-cli] WARN`, `claude를 사용할 수 없어 codex fallback`, 서버 health 200이다. 선택된 provider와 대체 provider는 현재 config에 따라 반대가 될 수 있다.

각 시나리오의 증거를 확인한 뒤에는 해당 `$ROOT`를 `rm -rf "$ROOT"`로 정리한다. 실행 중인 검증용 PID가 있다면 먼저 그 PID만 `TERM` 후 `wait`한다.

data path가 파일이거나 읽기 전용이면 현재 구현은 복구 후보의 쓰기 가능성을 검증하기 위해 `$HOME/.crewdeck-fallback`을 생성하고 빈 디렉터리로 남긴다. DB·key·PID는 생성하지 않지만 파일시스템 변경이 0은 아니다. 이 E2E는 임시 `HOME`으로 변경을 격리하며, “실패 시 어떤 디렉터리도 남기지 않음”을 요구한다면 별도 수정 전까지 PASS로 판정하면 안 된다.

### 7. 정상 dashboard smoke

현재는 패키지 설치 blocker 때문에 이 절차를 `dist/bin/crewdeck.js`로만 통과했다. blocker 수정 후에는 반드시 1번의 tarball `npx` 프로세스로 동일 검증을 수행한다.

```bash
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crewdeck-smoke.XXXXXX")
DATA_DIR="$ROOT/data"
mkdir "$DATA_DIR"
PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node dist/bin/crewdeck.js --data-dir="$DATA_DIR" --port="$PORT" --no-open >"$ROOT/smoke.log" 2>&1 &
PID=$!
cleanup() {
  if kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID"; fi
  wait "$PID" 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

# health가 준비될 때까지 최대 30초 polling
ATTEMPT=0
until curl -fsS "http://127.0.0.1:$PORT/api/health" >"$ROOT/health.json" 2>/dev/null; do
  ATTEMPT=$((ATTEMPT + 1))
  if ! kill -0 "$PID" 2>/dev/null || test "$ATTEMPT" -ge 300; then
    sed -n '1,200p' "$ROOT/smoke.log"
    exit 1
  fi
  sleep 0.1
done

curl -fsS -o "$ROOT/index.html" "http://127.0.0.1:$PORT/"
ASSET=$(sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' "$ROOT/index.html" | head -1)
curl -fsS -o /dev/null "http://127.0.0.1:$PORT$ASSET"
```

2026-07-11 실측은 health `{"status":"ok","version":"0.1.0"}`, dashboard HTML 200, JS asset 200이었다.

---

## 자동 회귀 매핑

```bash
npx vitest run server/core/preflight server/__tests__/startup-preflight.test.ts
npm run typecheck
npm run build
git diff --check
```

2026-07-11 결과:

- preflight 관련 Vitest: **55/55 PASS**
- 전체 Vitest: **404/405 PASS** — 기존 `server/__tests__/evaluator-diff.test.ts` 의 `.omc` gitignore fixture 1건 실패
- server TypeScript: **PASS**
- server + dashboard 전체 build: **PASS**
- whitespace: **PASS**

| 계약 | 회귀 위치 |
|---|---|
| Node 최소 버전·ABI·binding 분류·인메모리 probe | `server/core/preflight/runtime-checks.test.ts` |
| data dir 우선순위·생성·probe 정리·파일·권한·포트·PID lock | `server/core/preflight/environment-checks.test.ts` |
| provider 미설치·미인증·timeout·fallback·재실행 인자·민감정보 | `server/core/preflight/provider-check.test.ts` |
| 복수 실패 일괄 출력·halt chain·non-zero 오류 모델 | `server/core/preflight/runner.test.ts` |
| 기존 DB read-only 점검·PID/DB 초기화 전 종료 | `server/__tests__/startup-preflight.test.ts` |

자동 회귀는 npm tarball 설치 스크립트와 dashboard HTTP 접근을 관통하지 않는다. 따라서 55개 테스트가 통과해도 이 E2E Quality Gate를 대체할 수 없다.

---

## PASS 전환 체크리스트

- [ ] 배포 tarball의 install lifecycle이 빈 cwd에서 exit 0이다.
- [ ] 빈 npm cache의 `npx crewdeck` 실행이 CLI preflight banner에 진입한다.
- [ ] 정상 환경에서 모든 필수 check가 PASS이다.
- [ ] 같은 npx 프로세스의 `/api/health`, `/`, JS asset이 모두 HTTP 200이다.
- [ ] 종료 후 임시 data dir·cwd·npm cache를 정리했고 상시 서비스에 restart/kill 이력이 없다.
- [ ] 이 문서의 환경 매트릭스와 자동 회귀가 다시 통과한다.
