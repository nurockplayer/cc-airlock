# Claude Code Airlock

![GitHub repo size](https://img.shields.io/github/repo-size/nurockplayer/cc-airlock)
![GitHub](https://img.shields.io/github/license/nurockplayer/cc-airlock)
![GitHub issues](https://img.shields.io/github/issues/nurockplayer/cc-airlock)
![GitHub stars](https://img.shields.io/github/stars/nurockplayer/cc-airlock?style=social)

**Tagline**: Codex-powered risk review for Claude Code `bypassPermissions`

[English] | [日本語](locales/README.ja.md) | [繁體中文](locales/README.zh-TW.md) | [한국어](locales/README.ko.md)

## What does it do?

When you enable `bypassPermissions` in Claude Code, all `ask` permissions are automatically granted—meaning Claude will no longer pause to ask you before running potentially risky commands (like `git push`, `npm install`, file writes, etc.).

This plugin restores a safety layer: **every non‑read‑only operation is first sent to Codex (with a fallback to DeepSeek)** for a risk assessment. Only if **both** Codex and DeepSeek explicitly return `HUMAN` will Claude pause and ask you for confirmation. Otherwise, the action proceeds automatically.

In short:
- ✅ Read‑only tools (Read, Grep, Glob, TaskList, WebFetch, …) → **instant pass**.
- ⚠️ Write tools (Write, Edit, MultiEdit) → **instant pass for normal files; ask user for sensitive paths** (`.env`, credentials, keys).
- ⚠️ Everything else (Bash, Agent, Task, Cron* …) → **Codex review → DeepSeek fallback → ask only if both say HUMAN.**
- 🛡️ Bash commands are first screened by a hard floor (blocks `git reset --hard` and `git clean`), then judged by Codex with PR commands receiving enriched git/PR context.

This lets you enjoy the speed of `bypassPermissions` while still catching truly dangerous actions (e.g., `rm -rf /`, `git push --force`, writing secret files) before they run.

## Installation

### Prerequisites
- Claude Code with `bypassPermissions` enabled (see your `settings.json`: `"permissionMode": "bypassPermissions"`).
- Node.js (used by the hook).
- (Optional) A DeepSeek API key for the fallback. Set the environment variable `DEEPSEEK_API_KEY`. If not set, the plugin will still work—it will just ask you whenever Codex is unsure.

### One‑line install

```bash
git clone https://github.com/nurockplayer/cc-airlock.git
cd cc-airlock
chmod +x scripts/install.sh
./scripts/install.sh
```

The installer will:
1. Copy the hook scripts to `~/.claude/plugins/cc-airlock/hooks/`.
2. Automatically add `"permissionMode": "bypassPermissions"` and the PreToolUse hook chain to your `~/.claude/settings.json` (existing hooks are preserved).
3. Ensure `~/.claude/CLAUDE.md` contains the dual-report rule (final report must include both Claude's own report and Codex's review report).

### Manual install (if you prefer)

1. Copy the `hooks/` folder to `~/.claude/plugins/cc-airlock/`.
2. Add the following to your `~/.claude/settings.json` (or `<project>/.claude/settings.local.json`).  
   **Important:** Use an absolute path for `HOME` — `~` and `{{pluginDir}}` are not expanded in manual settings.

   Replace `/Users/you` with your actual home directory, or use the install script which handles this automatically.

   ```json
   {
     "permissionMode": "bypassPermissions",
     "hooks": {
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
               "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/dangerous-git-guard.js\"",
               "timeout": 5
             }
           ]
         },
         {
           "matcher": "Bash|Agent|Task|CronCreate|CronDelete|NotebookEdit|EnterWorktree|ExitWorktree|Workflow",
           "hooks": [
             {
               "type": "command",
               "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/codex-full-access-guard.js\"",
               "timeout": 30
             }
           ]
         }
       ]
     }
   }
   ```
3. (Optional) Export your DeepSeek key:
   ```bash
   export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   Add it to your shell profile so it’s available to Claude Code.

4. Add the dual-report rule to `~/.claude/CLAUDE.md` (create the file if it doesn’t exist).
   If a section titled `## 最終回報雙軌制` or equivalent content already exists, skip this step.

   Append the following:

   ```markdown
   ## 最終回報雙軌制

   每輪任務完成後，最終回報必須同時包含兩份報告，缺一不可：

   1. **Claude 自身回報**：變更摘要、驗證結果、殘餘風險
   2. **Codex 審查回報**：Spec Compliance（規格遵循性）+ Spec Adequacy（規格充足性）雙重驗證結果，含最終裁決（SAFE / must-fix）

   兩份報告寫入工作目錄的 `memory/last-report.md`（若 `memory/` 目錄不存在則先建立）。
   ```

## How it works

When a tool request arrives:

1. **Built‑in read‑only tools** (`Read`, `Grep`, `Glob`, `TaskList`, `TaskGet`, `TaskOutput`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `WebFetch`, `WebSearch`, `CronList`, `Skill`, `Plan`, `NotebookRead`) → **immediate pass**.
2. **Write tools** (`Write`, `Edit`, `MultiEdit`) → **immediate pass** for normal files; **ask user** if the target path matches sensitive patterns (`.env`, `credentials`, `secrets`, `*.pem`, `*.key`, `id_rsa`, etc.).
3. **MCP read‑only tools** (anything matching `mcp__.+__ (read|list|…)`) → **immediate pass**.
4. **Bash commands**:
   - If the command matches a strict read‑only whitelist (e.g., `git status`, `ls`, `cat`, pipelines) → **immediate pass**.
   - Otherwise → send to **Codex**. PR commands (`gh pr create/merge/close/reopen`) get enriched git/PR context for better judgment.
5. **Other tools** (`Agent`, `Task`, `Cron*`, `NotebookEdit`, `EnterWorktree`, `ExitWorktree`, `Workflow`) → send to **Codex**.

**Codex review**:
- The prompt asks Codex to reply with exactly `SAFE` or `HUMAN`.
- If Codex replies `SAFE` → **pass**.
- If Codex replies `HUMAN` → **ask the user**.
- If Codex gives no clear verdict (timeout, error, empty) → **fallback to DeepSeek API** with the same prompt.
- If DeepSeek replies `SAFE` → **pass**.
- If DeepSeek replies `HUMAN` → **ask the user**.
- If both fail to give a clear verdict → **ask the user** (conservative).

Because `bypassPermissions` is enabled, the `ask` decision from the hook will **not** show a prompt unless the hook explicitly returns `HUMAN`. In practice, this means:
- Most day‑to‑day operations (editing files, running tests, non‑force pushes) are auto‑approved.
- Only truly risky actions (deleting large trees, force‑pushing to main, writing credentials, etc.) will trigger a prompt.

## Customisation

You can adjust the following by editing the hook files or your environment:

| What | How |
|------|-----|
| **DeepSeek model** | Change the model name in `callJudgeAPI` inside `codex-full-access-guard.js` (currently `deepseek-chat`). |
| **Timeouts** | Modify the `timeout` values in `codex-full-access-guard.js` (Codex: 12000 ms, DeepSeek: 10000 ms). |
| **Additional read‑only commands** | Edit the `READ_ONLY_CMDS`, `READ_ONLY_GIT_SUB`, `READ_ONLY_GH_ACTION` sets in `codex-full-access-guard.js`. |
| **Extra dangerous Git patterns** | Edit the `dangerousSegment` function in `dangerous-git-guard.js`. |

## Uninstall

To remove the Airlock plugin:
1. Delete the folder `~/.claude/plugins/cc-airlock/`.
2. Remove the `PreToolUse` entries that point to `dangerous-git-guard.js` and `codex-full-access-guard.js` from your `~/.claude/settings.json`.
3. (Optional) Unset `DEEPSEEK_API_KEY` if you no longer need it.

## License

MIT © 2025 Your Name

Feel free to open issues or submit pull requests on GitHub if you have ideas for improvement!