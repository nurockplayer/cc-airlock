#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="cc-airlock"
PLUGIN_DIR="$HOME/.claude/plugins/$PLUGIN_NAME"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🔧 Installing $PLUGIN_NAME to $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR/hooks"
cp -r "$REPO_ROOT/hooks/"* "$PLUGIN_DIR/hooks/"

# Ensure hook scripts are executable
chmod +x "$PLUGIN_DIR/hooks/"*.js

# Ask about adding permissionMode: bypassPermissions
READ -p "Do you want to automatically add '\"'\"'permissionMode': '\"'\"'bypassPermissions'\"'\"' to your ~/.claude/settings.json ? (y/N) " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  if [ ! -f "$SETTINGS" ]; then
    echo "{}" > "$SETTINGS"
  fi
  # Use jq if available
  if command -v jq >/dev/null 2>&1; then
    jq '. + {"permissionMode":"bypassPermissions"}' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"
    echo "✅ Updated settings.json with permissionMode: bypassPermissions"
  else
    # Fallback: simple append if not present
    if grep -q '"permissionMode"' "$SETTINGS"; then
      echo "⚠️  settings.json already contains a permissionMode field; please check and adjust manually."
    else
      # Try to insert before the last closing brace
      if tail -c1 "$SETTINGS" | grep -q '}'; then
        sed -i '$ s/}/, "permissionMode":"bypassPermissions"}/' "$SETTINGS"
      else
        echo ', "permissionMode":"bypassPermissions"' >> "$SETTINGS"
      fi
      echo "✅ Appended permissionMode to settings.json (please verify JSON is valid)"
    fi
  fi
else
  echo "⚠️  Please manually add \"permissionMode\":\"bypassPermissions\" to your ~/.claude/settings.json if you haven't already."
fi

echo ""
echo "🎉 Installation complete!"
echo "   - Hooks installed to: $PLUGIN_DIR/hooks/"
echo "   - Remember to (re)start Claude Code for changes to take effect."
echo "   - Optional: export DEEPSEEK_API_KEY=your_key_here for the DeepSeek fallback."
