#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="cc-airlock"
PLUGIN_DIR="$HOME/.claude/plugins/$PLUGIN_NAME"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"

FULL_ACCESS_HOOK_TIMEOUT="${CC_AIRLOCK_HOOK_TIMEOUT:-75}"

echo "🔧 Installing $PLUGIN_NAME to $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR/hooks"
cp -r "$REPO_ROOT/hooks/"* "$PLUGIN_DIR/hooks/"
chmod +x "$PLUGIN_DIR/hooks/"*.js

# ── Add hooks to settings.json ──
echo ""
if [ ! -f "$SETTINGS" ]; then
  echo "{}" > "$SETTINGS"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "⚠️  jq not found. Please install jq (brew install jq) or add hooks manually."
  echo "   See README.md for the Manual install section."
  echo ""
  echo "⚠️  DEGRADED INSTALL: jq 不可用，無法自動設定 hooks 與 permissionMode。"
  echo "   請手動將 README.md Manual install 中的 hooks JSON 加入 $SETTINGS"
  echo "   並確保 \"permissionMode\": \"bypassPermissions\" 已設定。"
else
  # Build the hooks JSON with absolute plugin dir path
  HOOKS_JSON=$(jq -n --arg dir "$PLUGIN_DIR" --argjson fullTimeout "$FULL_ACCESS_HOOK_TIMEOUT" '{
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": ("node \"" + $dir + "/hooks/codex-full-access-guard.js\""),
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": ("node \"" + $dir + "/hooks/dangerous-git-guard.js\""),
            "timeout": 5
          }
        ]
      },
      {
        "matcher": "Bash|Agent|Task|CronCreate|CronDelete|NotebookEdit|EnterWorktree|ExitWorktree|Workflow",
        "hooks": [
          {
            "type": "command",
            "command": ("node \"" + $dir + "/hooks/codex-full-access-guard.js\""),
            "timeout": $fullTimeout
          }
        ]
      }
    ]
  }')

  # Backup existing settings before modifying
  if [ -f "$SETTINGS" ] && [ -s "$SETTINGS" ]; then
    cp "$SETTINGS" "${SETTINGS}.bak-$(date +%Y%m%d-%H%M%S)"
  fi

  # Merge: keep existing PreToolUse hooks, add cc-airlock ones
  # Use jq to deep-merge — existing hooks are preserved, cc-airlock entries are added.
  # Wrapped in if/else to prevent set -e from exiting on merge failure;
  # CLAUDE.md injection must run regardless of settings merge outcome.
  if jq --argjson hooks "$HOOKS_JSON" '
    . + {"permissionMode": "bypassPermissions"}
    | if .hooks then . else .hooks = {} end
    | .hooks.PreToolUse = (
        if .hooks.PreToolUse then .hooks.PreToolUse else [] end
        | map(select(
            (.hooks // []) | any(
              (.command // "") | (contains("cc-airlock") | not)
            )
          ) | select(.hooks | length > 0)
        )
        + $hooks.PreToolUse
      )
  ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"; then
    echo "✅ 已合併 permissionMode + PreToolUse hooks 至 $SETTINGS"
    echo "   既有 hooks 已保留，cc-airlock 條目已加入"
  else
    rm -f "${SETTINGS}.tmp" || true
    echo "⚠️  settings.json merge 失敗，但安裝將繼續進行。"
    echo "   請手動將 README.md Manual install 中的 hooks JSON 加入 $SETTINGS"
  fi
fi

# ── Ensure dual-report rule in CLAUDE.md ──
install_dual_report_rule() {
  mkdir -p "$CLAUDE_DIR"
  if [ ! -f "$CLAUDE_MD" ]; then
    touch "$CLAUDE_MD"
  fi

  # Detect existing rule by heading or equivalent key strings
  if grep -qF '## 最終回報雙軌制' "$CLAUDE_MD"; then
    echo "⏭️  雙重回報規則已存在於 $CLAUDE_MD，跳過。"
    return 0
  fi

  # Also detect by three key strings from the rule body
  if grep -qF 'memory/last-report.md' "$CLAUDE_MD" \
    && grep -qF 'Spec Compliance' "$CLAUDE_MD" \
    && grep -qF 'Spec Adequacy' "$CLAUDE_MD"; then
    echo "⏭️  等效雙重回報規則已存在於 $CLAUDE_MD，跳過。"
    return 0
  fi

  local APPEND="

## 最終回報雙軌制

每輪任務完成後，最終回報必須同時包含兩份報告，缺一不可：

1. **Claude 自身回報**：變更摘要、驗證結果、殘餘風險
2. **Codex 審查回報**：Spec Compliance（規格遵循性）+ Spec Adequacy（規格充足性）雙重驗證結果，含最終裁決（SAFE / must-fix）

兩份報告寫入工作目錄的 \`memory/last-report.md\`（若 \`memory/\` 目錄不存在則先建立）。"

  # If file exists and is non-empty, ensure trailing newline separation
  if [ -s "$CLAUDE_MD" ]; then
    # Ensure file ends with at least one newline before appending
    if [ "$(tail -c 1 "$CLAUDE_MD" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$CLAUDE_MD"
    fi
  fi

  printf '%s\n' "$APPEND" >> "$CLAUDE_MD"
  echo "✅ 雙重回報規則已寫入 $CLAUDE_MD"
}

install_dual_report_rule

echo ""
echo "🎉 Installation complete!"
echo "   - Hooks installed to: $PLUGIN_DIR/hooks/"
echo "   - Final-report rule ensured in: $CLAUDE_MD"
echo "   - Full-access hook timeout: ${FULL_ACCESS_HOOK_TIMEOUT}s"
echo "   - Remember to restart Claude Code for changes to take effect."
echo "   - Optional: export DEEPSEEK_API_KEY=your_key_here for the DeepSeek fallback."
