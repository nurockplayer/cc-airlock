# Workflow lifecycle enforcement

`CLAUDE.md` is guidance. It can tell Claude to follow a process, but it cannot prove that the process happened. `workflow-enforcer.js` adds a separate state machine that turns the required lifecycle into executable policy:

```text
Analysis Packet + Codex Implementation Spec
                  ↓
             implementation
                  ↓
 Codex Spec Compliance + Codex Spec Adequacy
                  ↓
                Stop
```

The safety guards and the workflow guard solve different problems:

- `codex-full-access-guard.js` and `dangerous-git-guard.js` decide whether an individual operation is safe.
- `workflow-enforcer.js` decides whether that operation is occurring at the correct point in the required lifecycle.

## Enforced invariants

1. Read-only and conversational work remains available immediately.
2. Mutating tools are denied until a successful strict read-only `codex exec` call contains both `Analysis Packet` and `Implementation Spec`, and Codex returns a substantive Implementation Spec section.
3. Only successful hook-observed Codex calls advance state. A prose claim that “Codex reviewed it” does not count.
4. Every mutation invalidates earlier verification.
5. Claude Code cannot finish a mutating turn until both Spec Compliance and Spec Adequacy verdicts were produced after the latest mutation.
6. A combined dual-verification Codex call is accepted when both sections contain their own verdict.
7. State is stored outside the project at `~/.claude/cc-airlock/workflow-state/<session_id>.json`, written atomically with private permissions, and removed on successful Stop or SessionEnd.

## Modes

Set `CC_AIRLOCK_WORKFLOW_MODE` before launching Claude Code:

| Value | Behavior |
|---|---|
| `enforce` | Default. Deny pre-spec mutations and block incomplete Stop events. |
| `audit` | Record state and inject guidance without denying tools or blocking Stop. |
| `off` | Disable workflow lifecycle processing. Existing safety guards still run. |

For tests only, `CC_AIRLOCK_STATE_DIR` can redirect state to a temporary directory.

## Manual hook configuration

Use absolute paths. Omitting `matcher` makes the lifecycle hook run for every matching event/tool, which is required so unknown mutating tools fail closed.

```json
{
  "permissionMode": "bypassPermissions",
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/workflow-enforcer.js\"",
            "timeout": 10
          }
        ]
      }
    ],
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
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/workflow-enforcer.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/workflow-enforcer.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/workflow-enforcer.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/Users/you/.claude/plugins/cc-airlock/hooks/workflow-enforcer.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The installer performs this merge idempotently. It removes only older cc-airlock command entries and preserves unrelated hooks, including unrelated commands that share the same hook group.

## State transitions

| Event | Transition |
|---|---|
| `UserPromptSubmit` | Start a fresh turn and inject the lifecycle requirements. |
| Valid spec `PostToolUse` | Record spec evidence and unlock mutation. |
| Mutating `PostToolUse` | Record the latest mutation and clear prior verification. |
| Compliance/Adequacy `PostToolUse` | Record hashed command/response evidence. |
| `Stop` | Allow read-only turns; otherwise require both verification revisions after the latest mutation. |
| `SessionEnd` | Delete session state. |

The state file stores hashes and transition metadata, not full prompts or Codex responses.
