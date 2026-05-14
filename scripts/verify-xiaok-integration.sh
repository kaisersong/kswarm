#!/usr/bin/env bash
# verify-xiaok-kswarm.sh
#
# 自动验证 kswarm + xiaok 集成：
# 1. 启动 kswarm server
# 2. API 断言：seed agents、runtimes、providers、创建项目、创建智能体
# 3. 报告结果
#
# Usage: bash scripts/verify-xiaok-integration.sh

set -euo pipefail

KSWARM_PORT=4400
KSWARM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
ERRORS=""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

assert_ok() {
  local desc="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS\n  - $desc"
  fi
}

assert_contains() {
  local desc="$1"
  local haystack="$2"
  local needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $desc (expected to contain: $needle)"
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS\n  - $desc"
  fi
}

assert_not_empty() {
  local desc="$1"
  local actual="$2"
  if [ -n "$actual" ]; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $desc (got empty)"
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS\n  - $desc"
  fi
}

echo -e "${YELLOW}=== KSwarm + xiaok Integration Verification ===${NC}"
echo ""

# ── 1. Start kswarm server ──
echo "1. Starting kswarm server..."
# Kill any existing server
lsof -ti :$KSWARM_PORT | xargs kill 2>/dev/null || true
sleep 1

node "$KSWARM_DIR/src/server/index.js" &
SERVER_PID=$!
sleep 3

# Health check
HEALTH=$(curl -s "http://127.0.0.1:$KSWARM_PORT/health" 2>/dev/null || echo "")
assert_contains "Server health check" "$HEALTH" '"ok":true'

echo ""
echo "2. Verifying seed agents..."
AGENTS=$(curl -s "http://127.0.0.1:$KSWARM_PORT/agents" 2>/dev/null || echo "{}")
assert_contains "PO-Agent exists" "$AGENTS" "PO-Agent"
assert_contains "Worker-Agent exists" "$AGENTS" "Worker-Agent"
assert_contains "xiaok runtimeType" "$AGENTS" "xiaok"

echo ""
echo "3. Verifying runtimes..."
RUNTIMES=$(curl -s "http://127.0.0.1:$KSWARM_PORT/runtimes" 2>/dev/null || echo "{}")
assert_contains "xiaok runtime" "$RUNTIMES" "xiaok"
assert_contains "claude runtime" "$RUNTIMES" "claude"
assert_contains "codex runtime" "$RUNTIMES" "codex"
assert_contains "gemini runtime" "$RUNTIMES" "gemini"
assert_contains "qoder runtime" "$RUNTIMES" "qoder"

echo ""
echo "4. Verifying LLM providers..."
PROVIDERS=$(curl -s "http://127.0.0.1:$KSWARM_PORT/llm/providers" 2>/dev/null || echo "{}")
assert_contains "openai provider" "$PROVIDERS" "openai"
assert_contains "anthropic provider" "$PROVIDERS" "anthropic"
assert_contains "ollama provider" "$PROVIDERS" "ollama"

echo ""
echo "5. Testing create agent..."
CREATE_RESULT=$(curl -s -X POST "http://127.0.0.1:$KSWARM_PORT/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test-Agent","roles":["worker"],"runtimeType":"xiaok","instructions":"test"}' 2>/dev/null || echo "{}")
assert_contains "Agent created successfully" "$CREATE_RESULT" '"ok":true'
assert_contains "Agent has xiaok runtime" "$CREATE_RESULT" "xiaok"

# Cleanup: delete test agent
TEST_AGENT_ID=$(echo "$CREATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('agent',{}).get('id',''))" 2>/dev/null || echo "")
if [ -n "$TEST_AGENT_ID" ]; then
  curl -s -X DELETE "http://127.0.0.1:$KSWARM_PORT/agents/$TEST_AGENT_ID" >/dev/null 2>&1 || true
fi

echo ""
echo "6. Testing create project..."
# Find PO agent ID
PO_ID=$(echo "$AGENTS" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for a in data.get('agents', []):
    if 'project_owner' in a.get('roles', []) and not a.get('archivedAt'):
        print(a['id']); break
" 2>/dev/null || echo "")
assert_not_empty "Found PO agent" "$PO_ID"

if [ -n "$PO_ID" ]; then
  PROJ_RESULT=$(curl -s -X POST "http://127.0.0.1:$KSWARM_PORT/projects" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"E2E-Test\",\"goal\":\"verify integration\",\"poAgent\":\"$PO_ID\"}" 2>/dev/null || echo "{}")
  assert_contains "Project created" "$PROJ_RESULT" '"ok":true'

  PROJ_ID=$(echo "$PROJ_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('project',{}).get('id',''))" 2>/dev/null || echo "")
  assert_not_empty "Got project ID" "$PROJ_ID"

  # Get project detail
  if [ -n "$PROJ_ID" ]; then
    DETAIL=$(curl -s "http://127.0.0.1:$KSWARM_PORT/projects/$PROJ_ID" 2>/dev/null || echo "{}")
    assert_contains "Project detail has tasks" "$DETAIL" "tasks"
    assert_contains "Project detail has activities" "$DETAIL" "activities"
    assert_contains "Project detail has workspace" "$DETAIL" "workspace"
  fi
fi

# ── Cleanup ──
echo ""
echo "7. Cleanup..."
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
echo -e "  ${GREEN}PASS${NC} Server stopped"

# ── Summary ──
echo ""
echo -e "${YELLOW}=== Results ===${NC}"
TOTAL=$((PASS + FAIL))
echo "  Total: $TOTAL | Pass: $PASS | Fail: $FAIL"
if [ $FAIL -gt 0 ]; then
  echo -e "  ${RED}Failed tests:${NC}$ERRORS"
  exit 1
else
  echo -e "  ${GREEN}All checks passed!${NC}"
  exit 0
fi
