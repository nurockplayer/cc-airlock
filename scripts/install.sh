#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="cc-airlock"
PLUGIN_DIR="$HOME/.claude/plugins/$PLUGIN_NAME"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="$HOME/.claude/settings.json"

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
  HOOKS_JSON=$(jq -n --arg dir "$PLUGIN_DIR" '{
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": []
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
            "timeout": 30
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
  # Use jq to deep-merge — existing hooks are preserved, cc-airlock entries are added
  jq --argjson hooks "$HOOKS_JSON" '
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
  ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"

  echo "✅ 已合併 permissionMode + PreToolUse hooks 至 $SETTINGS"
  echo "   既有 hooks 已保留，cc-airlock 條目已加入"
fi

echo ""
echo "🎉 Installation complete!"
echo "   - Hooks installed to: $PLUGIN_DIR/hooks/"
echo "   - Remember to restart Claude Code for changes to take effect."
echo "   - Optional: export DEEPSEEK_API_KEY=your_key_here for the DeepSeek fallback."
