# Goal-as-Unit E2E 경로 고정 — 실세계 실패 패턴 조사

작성일: 2026-07-10
대상: Goal-as-Unit E2E 경로 고정 후속 구현
목적: 실제 사용자 워크스페이스에서 재현 가능한 실패 패턴을 먼저 고정해 false-positive를 줄인다.

## 샘플링 기준

- 비밀 파일, `.crewdeck`, DB, `.env` 는 열지 않았다.
- 확인 범위는 경로, git/worktree 형태, manifest/package script, dirty 상태처럼 경로 처리와 squash 판단에 직접 영향을 주는 공개 메타데이터로 제한했다.
- 기준 정상 경로는 `생성 → goal worktree → 구현/검증/QA/acceptance가 같은 worktree 사용 → base branch 대비 filesChanged 계산 → pending_approval` 이다.

## 샘플링한 실제 워크스페이스

| 샘플 | 확인된 특성 | 경로 고정 리스크 |
|---|---|---|
| `/Users/keunsik/develop/givepro91/crewdeck/.crewdeck-worktrees/goal-goal-as-unit-e2e-경로-고정-19ebb279` | 현재 프로젝트 루트. Crewdeck 내부 worktree, 한글 slug, `.git` common dir는 부모 `crewdeck/.git`, `crewdeck-checkpoint-*` stash 존재 | imported project 자체가 이미 worktree일 때 부모 repo로 경로가 접히는지 |
| `/Users/keunsik/develop/givepro91/crewdeck` | 부모 Crewdeck repo. dirty tracked files와 ignored `.crewdeck-worktrees/` 존재 | 승인 squash가 base 작업물/ignored worktree residue를 건드리는지 |
| `/Users/keunsik/develop/givepro91/stockAssist` + `/Users/keunsik/develop/givepro91/stockAssist-telegram-interactive-briefing` | 같은 git common dir를 공유하는 일반 git worktree 쌍 | Crewdeck이 사용자가 만든 worktree를 원본 repo와 혼동하는지 |
| `/Users/keunsik/develop/givepro91/무제 폴더` | 공백 포함, 한글 NFD 경로, npm scripts 존재 | Unicode normalization/쉘 quoting 실패 |
| `/Users/keunsik/develop/swk/paperclip`, `/Users/keunsik/develop/swk/build-landbook-backend` | 기본 브랜치 `master`, 일부는 pnpm, 일부는 package manifest 없음 | `main` 하드코딩, npm script 가정 |
| `/Users/keunsik/develop/givepro91/markwand`, `/Users/keunsik/develop/swk/zippit`, `/Users/keunsik/develop/swk/PlanReview` | pnpm 프로젝트, script 이름이 `typecheck`, `check-types`, `verify` 등으로 다름 | acceptance script 일반화 실패 |
| `/Users/keunsik/develop/givepro91/miriva`, `/Users/keunsik/develop/givepro91/nova`, `/Users/keunsik/develop/swk/swk-data-pipeline` | git repo지만 package manifest 없음 | QA/acceptance에서 Node 프로젝트로 오판 |

## 실패 패턴 10가지

### 1. Imported project root가 이미 Crewdeck worktree인 경우

입력 예시:

```json
{
  "project.workdir": "/Users/keunsik/develop/givepro91/crewdeck/.crewdeck-worktrees/goal-goal-as-unit-e2e-경로-고정-19ebb279",
  "goal.title": "Goal-as-Unit E2E 경로 고정"
}
```

예상 결과:

- 신규 goal worktree는 imported root 아래의 `.crewdeck-worktrees/goal-...` 에 생성된다.
- `goals.worktree_path` 와 모든 agent/evaluator/QA/acceptance `cwd` 는 부모 `/Users/keunsik/develop/givepro91/crewdeck` 로 접히지 않는다.
- 승인 전까지 부모 repo의 dirty 파일, `.gitignore`, `.crewdeck-worktrees/` 는 변경되지 않는다.

실패 이유:

- `git rev-parse --show-toplevel` 또는 `.git` common dir 기준으로 project root를 재해석하면 imported worktree가 부모 repo로 접힌다.
- cleanup/stash/squash가 부모 repo에서 실행되면 사용자의 실제 작업물이나 다른 goal worktree를 건드린다.

회귀 고정 힌트:

- fixture는 `git worktree add` 로 만든 worktree를 다시 Crewdeck project root로 등록한다.
- assert: `spawn.workdir`, `goals.worktree_path`, preview API의 `worktree_path` 가 모두 imported worktree 하위인지 확인한다.

### 2. 공백 + NFD 한글 경로

입력 예시:

```json
{
  "project.workdir": "/Users/keunsik/develop/givepro91/무제 폴더",
  "goal.title": "다크 히어로 검증"
}
```

예상 결과:

- `existsSync(project.workdir)` 가 true이고, DB에 저장된 경로로 그대로 `spawnSync(..., { cwd })` 가 성공한다.
- goal slug는 한글을 보존하되 경로 존재성 판단은 사용자 파일시스템의 실제 normalization과 어긋나지 않는다.
- acceptance script가 별도 `cd <path>` 없이 worktree cwd에서 실행된다.

실패 이유:

- macOS 파일명은 NFD인 경우가 많다. 경로 문자열을 NFC로 저장/비교하거나 shell command 문자열에 직접 끼워 넣으면 실제 경로와 달라질 수 있다.
- 공백 경로를 quote 없이 `sh -c` 에 삽입하면 `cd: too many arguments` 류의 실패가 난다.

회귀 고정 힌트:

- fixture 경로를 NFD 한글 + 공백으로 만들고 `path !== path.normalize("NFC")` 를 확인한다.
- command는 문자열 concat 대신 `cwd` 옵션과 argv 배열로 검증한다.

### 3. 사용자가 만든 일반 git worktree를 project root로 등록한 경우

입력 예시:

```json
{
  "project.workdir": "/Users/keunsik/develop/givepro91/stockAssist-telegram-interactive-briefing",
  "git.commonDir": "/Users/keunsik/develop/givepro91/stockAssist/.git",
  "project.base_branch": "main"
}
```

예상 결과:

- Crewdeck goal worktree는 `stockAssist-telegram-interactive-briefing/.crewdeck-worktrees/goal-...` 아래에 생긴다.
- `CLAUDE.md`, target files, dirty status, QA diff는 등록된 worktree 기준으로 읽는다.
- 원본 `/stockAssist` root의 untracked `.omc/` 같은 파일은 이 goal의 변경으로 취급하지 않는다.

실패 이유:

- `.git` 이 파일인 worktree에서 common dir를 따라가면 원본 root를 project root로 오판한다.
- `git worktree list` 결과의 첫 번째 worktree를 main worktree로 잡으면 imported worktree가 아닌 원본에서 squash/diff가 실행된다.

회귀 고정 힌트:

- `git worktree add ../sample-feature feature/sample` 로 만든 feature worktree를 project로 seed한다.
- assert: 원본 root에는 파일 변경/branch checkout이 없고, imported worktree 하위에만 goal worktree가 생성된다.

### 4. 기본 브랜치가 `master` 인 repo

입력 예시:

```json
{
  "project.workdir": "/Users/keunsik/develop/swk/paperclip",
  "project.base_branch": null,
  "git branches": ["master"]
}
```

예상 결과:

- base branch는 `getDefaultBranch()` 또는 project 설정으로 `master` 가 된다.
- QA task description, `git diff master...HEAD`, squash approve checkout 모두 같은 base를 사용한다.
- `filesChanged` 가 비어 있지 않으면 `pending_approval` 로 갈 수 있다.

실패 이유:

- `main` 하드코딩은 `fatal: ambiguous argument 'main...HEAD'` 또는 checkout 실패를 만든다.
- 실패를 빈 diff로 삼키면 실제 변경이 있어도 `nothing-to-commit` 으로 blocked 되는 false-negative가 난다.

회귀 고정 힌트:

- fixture repo는 `git init -b master` 로 만들고 `main` 브랜치를 만들지 않는다.
- assert: activity/preview/QA description에 `main` 이 나오지 않는다.

### 5. 승인 시점 base workdir에 사용자의 dirty tracked 변경이 있는 경우

입력 예시:

```text
project.workdir = /Users/keunsik/develop/givepro91/crewdeck
base branch dirty sample:
 M .gitignore
 M server/core/orchestration/engine.ts
?? server/__tests__/llm-json.test.ts
```

예상 결과:

- squash approve는 사용자의 tracked 변경을 파괴하지 않는다.
- 필요하면 `crewdeck-squash-guard` stash로 보존하고, 성공/실패 후 복원하거나 복원 충돌을 명시적으로 warning/activity에 남긴다.
- 승인 전 `pending_approval` 상태에서는 base branch working tree가 변하지 않는다.

실패 이유:

- `git checkout <base>` 또는 merge 실패 복구에서 `reset --hard` 를 쓰면 사용자의 미커밋 변경이 손실된다.
- clean fixture만 쓰면 이 위험이 보이지 않아 approval path가 false PASS 된다.

회귀 고정 힌트:

- base root에 tracked dirty file을 만든 뒤 approve를 호출한다.
- assert: dirty file 내용이 보존되고, conflict 시 `warning` 또는 `goal_squash_blocked` 로 사용자에게 보인다.

### 6. 공유 stash에 기존 `crewdeck-checkpoint-*` 가 있는 경우

입력 예시:

```text
git stash list
stash@{0}: On goal/goal-as-unit-e2e-경로-고정-19ebb279: crewdeck-checkpoint-1134d3666244dbe5
```

예상 결과:

- 활성 goal의 checkpoint stash는 서버 시작 cleanup이나 다른 goal cleanup에 의해 삭제되지 않는다.
- task 실패 복원은 같은 worktree/goal/task label의 stash만 사용한다.
- checkpoint가 없을 때만 "pre-task tree was clean" 으로 보고 실패 task 변경을 폐기한다.

실패 이유:

- git stash는 common repo에 공유된다. 부모 repo에서 `stash list` 를 보면 worktree에서 만든 checkpoint도 보인다.
- cleanup이 prefix만 보고 전역 drop하면 활성 goal의 rollback 기준점이 사라지고, 이후 restore가 이전 task 산출물까지 폐기할 수 있다.

회귀 고정 힌트:

- 두 worktree에서 서로 다른 `crewdeck-checkpoint-*` stash를 만든다.
- assert: cleanup 대상이 아닌 active goal label은 남아 있고, restore는 다른 goal stash를 pop하지 않는다.

### 7. tool state 또는 관리 디렉토리가 변경 파일로 섞이는 경우

입력 예시:

```text
project root status sample:
?? .omc/
!! .crewdeck-worktrees/
!! .claude/worktrees/
```

예상 결과:

- WIP commit, preview `filesChanged`, squash 판단은 제품 변경 파일만 집계한다.
- `.crewdeck-worktrees/`, `.claude/worktrees/`, `.crewdeck/`, known tool state는 stage 대상과 filesChanged에서 제외된다.
- 제품 변경이 없고 tool state만 있으면 `pending_approval` 로 가지 않는다.

실패 이유:

- `git ls-files --others --exclude-standard` 를 그대로 preview에 섞으면 `.omc/` 같은 도구 상태가 변경 파일로 보인다.
- `git add -A -- . :(exclude)` 방식은 ignored path와 만나면 "ignored by .gitignore" 오류를 내거나, 반대로 tool state만 커밋하는 false-positive를 만든다.

회귀 고정 힌트:

- fixture에 제품 변경 없이 `.omc/cache.json` 과 ignored `.crewdeck-worktrees/x` 만 만든다.
- assert: `filesChanged.length === 0` 이고 squash는 blocked 또는 대기 유지다.

### 8. 파일명 자체가 공백/한글/rename/newline을 포함하는 경우

입력 예시:

```text
changed files:
 M "docs/검증 케이스.md"
 R "src/Old Page.tsx" -> "src/New Page.tsx"
 M "fixtures/name-with-\n-newline.txt"
```

예상 결과:

- stage, diff, preview, dashboard 표시에서 경로가 손상되지 않는다.
- rename은 새 경로 기준으로 stage되고, 파일명 안의 공백/한글은 그대로 유지된다.
- newline 파일명은 최소한 parser가 깨져 다른 파일로 오인하지 않는다.

실패 이유:

- `git diff --name-only` 를 line split + `trim()` 으로만 처리하면 newline 파일명이 여러 파일처럼 보인다.
- shell 문자열에 path를 직접 붙이면 공백/한글 경로가 깨진다.
- rename porcelain record를 단일 record로 보면 old path를 잘못 stage할 수 있다.

회귀 고정 힌트:

- path-safe 테스트는 `git status --porcelain -z` 를 우선 사용하고, preview API는 newline 파일명을 별도 케이스로 고정한다.
- UI 검증은 path 문자열이 누락/분리되지 않는지만 확인한다.

### 9. acceptance script가 프로젝트별 package manager/script와 맞지 않는 경우

입력 예시:

```json
[
  { "workdir": "/Users/keunsik/develop/givepro91/markwand", "packageManager": "pnpm@10.30.1", "valid": "pnpm typecheck" },
  { "workdir": "/Users/keunsik/develop/swk/PlanReview", "valid": "pnpm check-types" },
  { "workdir": "/Users/keunsik/develop/givepro91/summer-island", "valid": "npm run verify" },
  { "goal.acceptance_script": "npm run typecheck" }
]
```

예상 결과:

- Crewdeck는 acceptance script를 사용자가 지정한 그대로 goal worktree cwd에서 실행한다.
- script 미존재/패키지 매니저 불일치는 `goal_squash_blocked` 로 명확히 보이고, 기능 실패와 구분 가능해야 한다.
- 자동 생성 QA 문구는 `npm run dev` 를 예시로만 취급하고 프로젝트별 동등 명령을 선택하게 해야 한다.

실패 이유:

- 후속 구현/테스트가 모든 repo에 `npm run typecheck` 를 강제하면 pnpm repo나 `check-types` repo가 제품 변경과 무관하게 FAIL 된다.
- 반대로 command 실패를 무시하면 실제 acceptance 실패를 pending approval로 넘기는 false-positive가 된다.

회귀 고정 힌트:

- fixture package.json에 `check-types` 만 두고 `typecheck` 는 만들지 않는다.
- assert: `npm run typecheck` 는 blocked, `npm run check-types` 는 PASS로 분리된다.

### 10. package manifest가 없는 git repo

입력 예시:

```json
{
  "project.workdir": "/Users/keunsik/develop/givepro91/miriva",
  "manifest": "none",
  "goal.title": "문서 기반 정리 작업"
}
```

예상 결과:

- git repo이고 commit이 있으면 Goal-as-Unit worktree 생성과 squash 경로는 동작한다.
- QA task는 `npm` 전제를 강제하지 않고 repo를 읽어 적절한 검증 방법을 찾게 한다.
- acceptance script가 없으면 script 단계는 skip되고, 변경 파일이 있으면 `pending_approval` 로 갈 수 있다.

실패 이유:

- project analyzer나 QA runner가 package.json 부재를 실행 불가로 간주하면 문서/파이썬/비Node repo가 불필요하게 blocked 된다.
- manifest가 없다는 이유로 worktree fallback을 project root 직접 실행으로 바꾸면 Goal-as-Unit 격리가 깨진다.

회귀 고정 힌트:

- fixture는 package.json 없이 README만 있는 git repo로 만든다.
- assert: `createGoalWorktree` 는 성공하고, acceptance script 없음 + 실제 파일 변경 시 preview가 변경 파일을 반환한다.

## 후속 구현에서 특히 막아야 할 false-positive

- 변경 파일이 tool state뿐인데 `pending_approval` 로 넘어가는 경우.
- base branch가 `master` 인데 `main` diff 실패를 빈 변경으로 취급하는 경우.
- imported worktree를 부모 repo로 접어서 부모 dirty 상태를 goal 변경으로 오인하는 경우.
- acceptance script가 프로젝트별 검증 명령 불일치로 실패했는데 기능 회귀처럼 기록되는 경우.
- active checkpoint stash를 cleanup이 삭제해도 테스트가 깨끗한 tmp repo만 써서 감지하지 못하는 경우.
