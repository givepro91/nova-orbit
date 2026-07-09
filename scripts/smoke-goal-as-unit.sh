#!/usr/bin/env bash
# Goal-as-Unit 아키텍처 smoke 테스트.
# 서버 기동 상태에서 실행. DB 상태를 조회해 핵심 구조가 맞는지만 확인.
# 실제 E2E (goal 실행→QA→squash 관통) 는 수동 체크리스트(docs/verification/goal-as-unit-e2e.md)로.

set -euo pipefail

ROOT="${CREWDECK_ROOT:-$HOME/.crewdeck}"
DB="$ROOT/crewdeck.db"
API_KEY_FILE="$ROOT/api-key"
BASE="${CREWDECK_BASE:-http://localhost:7200}"

if [[ ! -f "$DB" ]]; then
  echo "❌ DB 없음: $DB — 서버를 먼저 기동하세요"
  exit 1
fi

API_KEY=""
if [[ -f "$API_KEY_FILE" ]]; then
  API_KEY="$(cat "$API_KEY_FILE")"
fi

fail=0
pass=0

check() {
  local label="$1"
  local sql="$2"
  local expected="$3"  # 정규식 또는 exact
  local actual
  actual="$(sqlite3 "$DB" "$sql" 2>/dev/null || echo "ERR")"
  if [[ "$actual" =~ $expected ]]; then
    echo "✅ $label: $actual"
    pass=$((pass + 1))
  else
    echo "❌ $label: expected=$expected actual=$actual"
    fail=$((fail + 1))
  fi
}

echo "=== Goal-as-Unit Schema Smoke ==="

# 1. 스키마 컬럼 존재 확인
check "goals.goal_model 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('goals') WHERE name='goal_model';" "^1$"

check "goals.squash_status 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('goals') WHERE name='squash_status';" "^1$"

check "goals.qa_regression_task_id 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('goals') WHERE name='qa_regression_task_id';" "^1$"

check "goals.acceptance_script 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('goals') WHERE name='acceptance_script';" "^1$"

check "goals.skip_adversarial 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('goals') WHERE name='skip_adversarial';" "^1$"

check "goals.worktree_path 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('goals') WHERE name='worktree_path';" "^1$"

check "projects.base_branch 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name='base_branch';" "^1$"

check "tasks.acceptance_script 컬럼" \
  "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name='acceptance_script';" "^1$"

# 2. 기존 goal 이 'legacy' 로 남아있는지 (하위 호환)
echo ""
echo "=== 하위 호환 ==="
legacy_count="$(sqlite3 "$DB" "SELECT COUNT(*) FROM goals WHERE goal_model='legacy';")"
goal_as_unit_count="$(sqlite3 "$DB" "SELECT COUNT(*) FROM goals WHERE goal_model='goal_as_unit';")"
echo "legacy goals: $legacy_count"
echo "goal_as_unit goals: $goal_as_unit_count"

# 3. 위험 상태 감지 — 'triggering' 고착, 미커밋 pending_approval 등
echo ""
echo "=== 상태 이상 탐지 ==="
stuck_triggering="$(sqlite3 "$DB" "SELECT COUNT(*) FROM goals WHERE squash_status='triggering';")"
if [[ "$stuck_triggering" != "0" ]]; then
  echo "⚠ 'triggering' 상태 고착 goal: $stuck_triggering 개 — 서버 재시작으로 복구 가능"
  fail=$((fail + 1))
else
  echo "✅ 'triggering' 고착 없음"
  pass=$((pass + 1))
fi

pending_without_worktree="$(sqlite3 "$DB" "SELECT COUNT(*) FROM goals WHERE squash_status='pending_approval' AND (worktree_path IS NULL OR worktree_path='');")"
if [[ "$pending_without_worktree" != "0" ]]; then
  echo "⚠ pending_approval 이지만 worktree_path 없음: $pending_without_worktree 개"
  fail=$((fail + 1))
else
  echo "✅ pending_approval goal 의 worktree_path 정합"
  pass=$((pass + 1))
fi

# 4. API 핑 (선택)
if [[ -n "$API_KEY" ]]; then
  echo ""
  echo "=== API 핑 ==="
  if curl -s -f -H "x-api-key: $API_KEY" "$BASE/health" > /dev/null 2>&1; then
    echo "✅ $BASE/health 200 OK"
    pass=$((pass + 1))
  else
    echo "⚠ $BASE/health 실패 — 서버 미기동 가능"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "PASS: $pass   FAIL: $fail"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit $((fail > 0 ? 1 : 0))
