# Claude Code Airlock

![GitHub repo size](https://img.shields.io/github/repo-size/nurockplayer/cc-airlock)
![GitHub](https://img.shields.io/github/license/nurockplayer/cc-airlock)
![GitHub issues](https://img.shields.io/github/issues/nurockplayer/cc-airlock)
![GitHub stars](https://img.shields.io/github/stars/nurockplayer/cc-airlock?style=social)

**Tagline**: Codex-powered risk review for Claude Code `bypassPermissions`

[English] | [日本語](locales/README.ja.md) | [繁體中文](locales/README.zh-TW.md) | [한국어](locales/README.ko.md)

## What does it do?

When you enable `bypassPermissions` in Claude Code, all `ask` permissions are automatically granted—meaning Claude will no longer pause to ask you before running potentially risky commands (like `git push`, `npm install`, file writes, etc.).

This plugin restores a safety layer with a deterministic guard + LLM judge pipeline:

- **Dangerous Git Guard** (shell wrapper stripping, `git reset --hard` / `git clean` detection, `rm -rf` root/wildcard protection) runs first and can **deny** or **ask** before any LLM is called.
- **Codex Full Access Guard** evaluates all remaining non-read-only calls:
  - Read-only tools → **instant pass**
  - Write/Edit/MultiEdit on sensitive paths (`.env`, `credentials`, `keys`, `*.pem`) → **ask user**
  - Codex workflow calls (`codex exec --sandbox read-only --ephemeral --skip-git-repo-check` with workflow markers) → **instant pass** (prevents gate-within-a-gate recursion)
  - All other tools → **Codex review** (primary judge). If Codex returns `SAFE` → **pass**. If Codex times out or returns no verdict → **DeepSeek fallback**. If neither returns `SAFE` → **ask the user**.
- All failure paths (timeout, parse error, missing fields, unexpected exception) → **ask the user** (fail-closed).

In short:
- ✅ Read-only tools (Read, Grep, Glob, TaskList, WebFetch, …) → **instant pass**.
- ⚠️ Write tools (Write, Edit, MultiEdit) → **instant pass for normal files; ask user for sensitive paths** (`.env`, credentials, keys).
- ⚠️ Codex workflow calls (`codex exec` with `--sandbox read-only --ephemeral --skip-git-repo-check` + workflow markers) → **instant pass**.
- ⚠️ Everything else (Bash, Agent, Task, Cron* …) → **Codex primary review → DeepSeek fallback → ask if neither says SAFE**.
- 🛡️ Bash commands are first screened by a hard floor (blocks `git reset --hard`, `git clean`, `rm -rf /` root/wildcard), then classified for read-only fast path, then judged by Codex. PR commands receive enriched git/PR context.

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
           "hooks": [
             {
               "type": "command",
               "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/codex-full-access-guard.js\"",
               "timeout": 10
             }
           ]
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

**Codex review** (primary judge):
- Codex replies with exactly `SAFE` or `HUMAN`.
- If Codex replies `SAFE` → **pass**.
- If Codex replies `HUMAN` → **ask the user**.
- If Codex gives no clear verdict (timeout, error, empty) → **fallback to DeepSeek API** with the same prompt.

**DeepSeek fallback** (secondary judge):
- If DeepSeek replies `SAFE` → **pass**.
- If DeepSeek replies `HUMAN` → **ask the user**.
- If both fail to give a clear verdict → **ask the user** (conservative).

**Workflow Codex bypass**: `codex exec` calls that carry workflow markers (`Implementation Spec`, `Spec Compliance`, `Spec Adequacy`, `Analysis Packet`, `Decision boundaries`, `[ASK CODEX]`, etc.) and meet strict safety criteria (`--sandbox read-only`, `--ephemeral`, `--skip-git-repo-check`, no command chaining, no write-capable flags) bypass the judge pipeline entirely — these are part of the Codex architect/verifier toolchain, not user tool invocations.

**Fail-closed**: All failure paths (stdin timeout, JSON parse error, missing tool name, unexpected exception) return `ask` rather than silently passing. The dangerous‑git guard also returns `ask` on parse errors.

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

## Configuration

Model aliases and routing options are defined in `lib/config.js`. They can be configured via environment variables (all prefixed with `CC_AIRLOCK_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_AIRLOCK_CHAT_MODEL` | `deepseek-v4-flash` | Model alias for chat/routing |
| `CC_AIRLOCK_JUDGE_MODEL` | `deepseek-v4-pro` | Model alias for binary SAFE/HUMAN judging |
| `CC_AIRLOCK_CODE_MODEL` | `codex` | Model alias for spec/compliance/review workflows |
| `CC_AIRLOCK_FLASH_CONFIDENCE_THRESHOLD` | `0.75` | Confidence threshold for Flash → Pro escalation |
| `CC_AIRLOCK_ESCALATE_ON_UNSURE` | `true` | Escalate to Pro when Flash is uncertain |
| `CC_AIRLOCK_ASK_ON_DISAGREEMENT` | `true` | Ask user when models disagree |
| `CC_AIRLOCK_ROUTING_DRY_RUN` | `false` | Log routing decisions without enforcing them |
| `CC_AIRLOCK_ENABLE_ROUTING` | `false` | Experimental: enable multi-model routing engine |

> **Warning:** The routing engine is experimental and disabled by default. It does NOT replace the hooks. See [Multi-Model Routing](#multi-model-routing) for details.

To override, export the variable in your shell profile:

```bash
export CC_AIRLOCK_CHAT_MODEL=deepseek-v4-pro
export CC_AIRLOCK_FLASH_CONFIDENCE_THRESHOLD=0.9
```

## Multi-Model Routing

cc-airlock includes an experimental multi-model routing engine behind `CC_AIRLOCK_ENABLE_ROUTING` (default: `false`). It classifies tool calls into one of six route types using `classifyAction()` / `routeDecision()` from `lib/routing-engine.js`:

| Route | Meaning | Example |
|-------|---------|---------|
| `pass` | Auto-approved, no judge needed | Read-only tools, workflow Codex calls |
| `ask` | Needs user confirmation | Writing to `.env`, unknown tools |
| `deny` | Blocked outright | `git reset --hard`, `rm -rf /` |
| `flash` | Route to Flash (low-cost chat model) | Safe Bash commands, normal file writes |
| `pro` | Route to Pro (high-accuracy judge) | PR write operations |
| `codex` | Route to Codex (highest authority) | Complex semantic judgments |

### Architecture

```
                  ┌──────────────┐
                  │  Tool Call   │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │  classify   │
                  │  Action()   │
                  └──────┬───────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          ┌──────┐  ┌────────┐  ┌───────┐
          │deny  │  │  ask   │  │ pass  │
          │block │  │human   │  │auto   │
          └──────┘  └────────┘  └───────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
         ┌────────┐           ┌─────────┐
         │ flash  │           │  pro    │
         │(cheap) │           │(accurate)│
         └────────┘           └─────────┘
                         │
                         ▼
                    ┌─────────┐
                    │  codex  │
                    │(highest)│
                    └─────────┘
```

### Components

| Component | File | Role |
|-----------|------|------|
| Routing Engine | `lib/routing-engine.js` | `classifyAction()` / `routeDecision()` |
| Config | `lib/config.js` | Model aliases and routing flags |
| Routing Trace | `lib/routing-trace.js` | Dry-run mode for routing decisions |
| Codex Helper Modes | `lib/codex-helper-modes.js` | Prompt template builders for spec/review |
| DeepSeek Client | `lib/deepseek-client.js` | Flash and Pro judge client |
| Codex Guard | `hooks/codex-full-access-guard.js` | Primary SAFE/HUMAN judge |
| Dangerous Git Guard | `hooks/dangerous-git-guard.js` | Hard-floor shell/git protection |

### Shell Extraction Depth

The routing engine performs deep extraction of nested shell constructs to detect dangerous commands hidden in:

- `$()` command substitution (recursive, quote-aware depth counting)
- Backtick command substitution
- `bash -c "..."` / `sh -c "..."` / `zsh -c "..."`
- Compound separators (`&&`, `||`, `;`, newline) — inside and outside quotes
- Pipes (`|`)
- Shell escape sequences (`\`) outside single quotes
- Output redirection (`>`, `>>`, `2>`, `<`)

All extraction respects shell quote state (single-quote, double-quote, escape) to avoid false positives on quoted literals.

### Does it replace the hooks?

No. The routing engine is complementary:

- **Hooks** run **after** routing, as the last line of defence before a tool call executes.
- **Routing engine** runs first, routing to the appropriate judge model (Flash, Pro, Codex) based on risk classification. It is an optimisation layer, not a security layer.

The hooks remain the authoritative safety gate regardless of routing configuration.

### Recommended Rollout Order

1. **Dry-run mode** (`CC_AIRLOCK_ROUTING_DRY_RUN=true`)
   - Logs routing decisions to stderr without enforcing them.
   - Safe to enable in any environment — no behavioural change.
   - Use to verify routing decisions match expectations.

2. **Experimental routing engine** (`CC_AIRLOCK_ENABLE_ROUTING=true`)
   - Enables the routing engine to make real routing decisions.
   - Start with `flash`-dominant workloads and watch for misclassifications.
   - The deny checks (`git reset --hard`, `rm -rf /`) run first and are always enforced.

3. **Stable — default enabled** (future)
   - After sufficient validation, routing becomes the default behaviour.
   - Hooks remain active as the authoritative safety gate underneath.

## Uninstall

To remove the Airlock plugin:
1. Delete the folder `~/.claude/plugins/cc-airlock/`.
2. Remove the `PreToolUse` entries that point to `dangerous-git-guard.js` and `codex-full-access-guard.js` from your `~/.claude/settings.json`.
3. (Optional) Unset `DEEPSEEK_API_KEY` if you no longer need it.

## License

MIT © 2025 Your Name

Feel free to open issues or submit pull requests on GitHub if you have ideas for improvement!