# Claude Code Airlock

![GitHub 리포지토리 크기](https://img.shields.io/github/repo-size/nurockplayer/cc-airlock)
![GitHub 라이선스](https://img.shields.io/github/license/nurockplayer/cc-airlock)
![GitHub 이슈](https://img.shields.io/github/issues/nurockplayer/cc-airlock)
![GitHub 스타](https://img.shields.io/github/stars/nurockplayer/cc-airlock?style=social)

**태그라인**: Claude Code `bypassPermissions` 를 위한 Codex 기반 위험 검토

[English] | [日本語] | [繁體中文] | [한국어]

## 무엇인가요?

`bypassPermissions` 를 활성화하면 Claude Code 가 모든 `ask` 권한을 자동으로 부여합니다—즉, `git push`, `npm install`, 파일 쓰기 등 잠재적으로 위험한 명령을 실행할 때 프롬프트 없이 바로 실행됩니다.

이 플러그인은 안전 레이어를 복원합니다: **읽기 전용이 아니며 쓰기 전용도 아닌 모든 작업은 먼저 Codex(백업으로서 DeepSeek)로 위험 평가를 전송**하고, **두 엔진이 모두 명확히 `HUMAN` 을 반환할 때만** Claude 가 일시 정지하여 사용자 확인을 요청합니다. 그렇지 않은 경우 작업이 자동으로 계속됩니다.

간단히 말하면:
- ✅ 읽기 전용 도구 (Read, Grep, Glob, TaskList, WebFetch, …) → **즉시 통과**
- ⚠️ 쓰기 도구 (Write, Edit, MultiEdit) → **Codex 검토 → DeepSeek 폴백 → 둘 다 HUMAN 일 때만 질문**
- ⚠️ 그 외 모든 것 (Bash, Agent, Task, Cron* …) → **Codex 검토 → DeepSeek 폴백 → 둘 다 HUMAN 일 때만 질문**

따라서 `bypassPermissions` 의 속도를 유지하면서 실제로 위험한 작업(예: `rm -rf /`, `git push --force`, 비밀 파일 쓰기 등)을 실행 전에 포착할 수 있습니다.

## 설치

### 전제 조건
- `bypassPermissions` 가 활성화된 Claude Code ( `settings.json` 에서 `"permissionMode": "bypassPermissions"` 확인)
- Node.js (훅에서 사용됨)
- (선택 사항) 폴백을 위한 DeepSeek API 키. 환경 변수 `DEEPSEEK_API_KEY` 를 설정하세요. 설정하지 않아도 플러그인은 여전히 작동하지만 Codex 가 불확실할 때만 사용자에게 질문을 보냅니다.

### 일괄 설치

```bash
git clone https://github.com/nurockplayer/cc-airlock.git
cd cc-airlock
chmod +x scripts/install.sh
./scripts/install.sh
```

설치 프로그램은 다음을 수행합니다:
1. 훅 스크립트를 `~/.claude/plugins/cc-airlock/hooks/` 로 복사합니다
2. 아직 설정되지 않은 경우 `~/.claude/settings.json` 에 `"permissionMode": "bypassPermissions"` 추가를 요청합니다
3. 모든 관련 툴 유형에 대해 Airlock 가드를 실행하는 `PreToolUse` 훅을 추가합니다

### 수동 설치 (원하는 경우)

1. `hooks/` 폴더를 `~/.claude/plugins/cc-airlock/` 로 복사합니다
2. `~/.claude/settings.json` 이 다음 내용을 포함하는지 확인하세요:
   ```json
   {
     "permissionMode": "bypassPermissions",
     "hooks": {
       "PreToken": [
         {
           "matcher": "Read|Grep|Glob|TaskList|TaskGet|TaskOutput|ListMcpResourcesTool|ReadMcpResourceTool|AskUserQuestion|EnterPlanMode|ExitPlanMode|WebFetch|WebSearch|CronList|Skill|Plan|NotebookRead",
           "hooks": []
         }
       ],
       "PreToolUse": [
         {
           "matcher": "Write|Edit|MultiEdit|Bash|Agent|Task|CronCreate|CronDelete|NotebookEdit|EnterWorktree|ExitWorktree|Workflow",
           "hooks": [
             {
               "type": "command",
               "command": "node \"~/.claude/plugins/cc-airlock/hooks/codex-full-access-guard.js\"",
               "timeout": 30
             }
           ]
         }
       ]
     }
   }
   ```
3. (선택 사항) 여러분의 DeepSeek 키를 내보내세요:
   ```bash
   export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   쉘 프로파일에 추가하여 Claude Code 가 접근할 수 있도록 하세요.

## 작동 방식

툴 요청이 도착할 때:

1. **내장 읽기 전용 도구** (`Read`, `Grep`, `Glob`, `TaskList`, `TaskGet`, `TaskOutput`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `WebFetch`, `WebSearch`, `CronList`, `Skill`, `Plan`, `NotebookRead`) → **즉시 통과**
2. **쓰기 도구** (`Write`, `Edit`, `MultiEdit`) → **Codex 검토 → DeepSeek 폴백 → 둘 다 HUMAN 일 때만 질문**
3. **MCP 읽기 전용 도구** ( `mcp__.+__ (read|list|…)` 와 일치하는 모든 것 ) → **즉시 통과**
4. **Bash 명령어**:
   - 명령이 엄격한 읽기 전용 화이트리스트와 일치하는 경우 (예: `git status`, `ls`, `cat`, 파이프라인) → **즉시 통과**
   - 그렇지 않으면 → **Codex** 로 전송
5. **기타 도구** (`Agent`, `Task`, `Cron*`, `NotebookEdit`, `EnterWorktree`, `ExitWorktree`, `Workflow`) → **Codex** 로 전송

**Codex 검토**:
- 프롬프트는 Codex 에 정확히 `SAFE` 또는 `HUMAN` 만 응답하도록 요청합니다.
- Codex 가 `SAFE` 를 반환 → **통과**
- Codex 가 `HUMAN` 를 반환 → **사용자에게 질문**
- Codex 가 명확한 판단을 내리지 못함 (타임아웃, 오류, 빈 출력) → 동일한 프롬프트로 **DeepSeek API** 로 폴백
- DeepSeek 가 `SAFE` 를 반환 → **통과**
- DeepSeek 가 `HUMAN` 을 반환 → **사용자에게 질문**
- 두 가지 모두 명확한 판단을 내리지 못함 → **사용자에게 질문** (보수적 처리)

`bypassPermissions` 가 활성화되어 있으므로, 훅에서 `ask` 결정은 훅이 명시적으로 `HUMAN` 을 반환할 경우에만 프롬프트가 표시됩니다. 실제로는 다음과 같습니다:
- 대부분의 일상 작업(파일 편집, 테스트 실행, 실행, 비강제 푸시 등)은 자동으로 승인됩니다
- 실제로 위험한 작업(큰 트리 삭제, 메인에 강제 푸시, 자격 증명 쓰기 등)만 프롬프트를 트리거합니다

## 사용자 정의

다음 항목을 훅 파일 또는 환경에서 조정할 수 있습니다:

| 무엇 | 어떻게 |
|------|------|
| **DeepSeek 모델** | `codex-full-access-guard.js` 내 `callJudgeAPI` 함수 내 모델 이름을 변경합니다(현재 `deepseek-chat`). |
| **타임아웃** | `codex-full-access-guard.js` 내 `timeout` 값을 수정합니다(Codex: 12000 ms, DeepSeek: 10000 ms). |
| **추가 읽기 전용 명령어** | `codex-full-access-guard.js` 의 `READ_ONLY_CMDS`, `READ_ONLY_GIT_SUB`, `READ_ONLY_GH_ACTION` 집합을 편집합니다. |
| **추가 위험한 Git 패턴** | `dangerous-git-guard.js` 의 `dangerousSegment` 함수를 편집합니다. |

## 제거

Airlock 플러그인을 제거하려면:
1. 폴더 `~/.claude/plugins/cc-airlock/` 를 삭제합니다
2. `~/.claude/settings.json` 에서 `codex-full-access-guard.js` 를 가리키는 `PreToolUse` 항목을 제거합니다
3. (선택 사항) 더 이상 필요하지 않은 경우 `DEEPSEEK_API_KEY` 를 해제합니다

## 라이선스

MIT © 2025 Your Name

개선 아이디어가 있으면 GitHub 에서 이슈를 열거나 풀 리퀘스트를 보내 주세요!