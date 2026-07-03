# Claude Code Airlock

![GitHub 倉庫大小](https://img.shields.io/github/repo-size/nurockplayer/cc-airlock)
![GitHub](https://img.shields.io/github/license/nurockplayer/cc-airlock)
![GitHub Issues](https://img.shields.io/github/issues/nurockplayer/cc-airlock)
![GitHub Stars](https://img.shields.io/github/stars/nurockplayer/cc-airlock?style=social)

**標語**：適用於 Claude Code `bypassPermissions` 的 Codex 驅動風險審查

[English] | [日本語] | [繁體中文] | [한국어]

## 它有什麼作用？

當您在 Claude Code 中啟用 `bypassPermissions` 時，所有 `ask` 權限將自動授予——這意味著 Claude 在執行可能具有風險的命令時（例如 `git push`、`npm install`、檔案寫入等）將不會再暫停並詢問您。

此外掛程式會恢復一個安全層：**每個非唯讀、非寫入操作將首先發送到 Codex（並有 DeepSeek 作為備援）進行風險評估**。只有在 **Codex 與 DeepSeek 都明確回傳 `HUMAN`** 時，Claude 才會暫停並詢問您確認。否則，操作將自動繼續。

簡單來說：
- ✅ 唯讀工具（Read、Grep、Glob、TaskList、WebFetch、…）→ **立即通過**
- ✅ 寫入工具（Write、Edit、MultiEdit）→ **立即通過**（由設計決定）
- ⚠️ 其他所有內容（Bash、Agent、Task、Cron* …）→ **Codex 審查 → DeepSeek 備援 → 只有在兩者皆為 HUMAN 時才詢問**

這樣您就能享受 `bypassPermissions` 的速度，同時仍能在執行前捕捉到真正危險的操作（例如 `rm -rf /`、`git push --force`、寫入秘密檔案等）。

## 安裝

### 先決條件
- 已啟用 `bypassPermissions` 的 Claude Code（請參閱您的 `settings.json`：`"permissionMode": "bypassPermissions"`）。
- Node.js（此外掛程式會使用它）。
- （可選）用於備援的 DeepSeek API 金鑰。設定環境變數 `DEEPSEEK_API_KEY`。如果未設定，外掛程式仍可運作——它只會在 Codex 不確定時詢問您。

### 一行安裝

```bash
git clone https://github.com/nurockplayer/cc-airlock.git
cd cc-airlock
chmod +x scripts/install.sh
./scripts/install.sh
```

安裝程式將：
1. 將 hook 腳本複製到 `~/.claude/plugins/cc-airlock/hooks/`
2. 如果尚未設定，會提示您將 `"permissionMode": "bypassPermissions"` 加入 `~/.claude/settings.json`
3. 為所有相關工具類型新增一個執行 Airlock 看門的 `PreToolUse` 鉤
4. 確保 `~/.claude/CLAUDE.md` 包含最終回報雙軌制規則（每輪完成後須同時回報 Claude 自身回報與 Codex 審查回報）

### 手動安裝（如果您更喜歡）

1. 將 `hooks/` 資料夾複製到 `~/.claude/plugins/cc-airlock/`。
2. 確認您的 `~/.claude/settings.json` 包含：
   ```json
   {
     "permissionMode": "bypassPermissions",
     "hooks": {
       "PreToken": [
         {
           "matcher": "Write|Edit|MultiEdit",
           "hooks": []
         },
         {
           "matcher": "Bash|Agent|Task|CronCreate|CronDelete|NotebookEdit|EnterWorktree|ExitWorktree|Workflow",
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
3. （可選）匯出您的 DeepSeek 金鑰：
   ```bash
   export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   將其加入您的 shell 配置檔，以便於讓 Claude Code 存取。

4. 將雙重回報規則加入 `~/.claude/CLAUDE.md`（若檔案不存在則新建）。
   若已有 `## 最終回報雙軌制` 段落或等效內容，跳過此步驟。

   追加以下內容：

   ```markdown
   ## 最終回報雙軌制

   每輪任務完成後，最終回報必須同時包含兩份報告，缺一不可：

   1. **Claude 自身回報**：變更摘要、驗證結果、殘餘風險
   2. **Codex 審查回報**：Spec Compliance（規格遵循性）+ Spec Adequacy（規格充足性）雙重驗證結果，含最終裁決（SAFE / must-fix）

   兩份報告寫入工作目錄的 `memory/last-report.md`（若 `memory/` 目錄不存在則先建立）。
   ```

## 運作方式

當工具請求到達時：

1. **內建唯讀工具** (`Read`, `Grep`, `Glob`, `TaskList`, …) → **立即通過**
2. **寫入工具** (`Write`, `Edit`, `MultiEdit`) → **立即通過**（由設計決定）
3. **MCP 唯讀工具** （任何匹配 `mcp__.+__ (read|list|…)` 的項目）→ **立即通過**
4. **Bash 命令**：
   - 如果命令匹配嚴格的僅讀白名單（例如 `git status`、`ls`、`cat`、管道） → **立即通過**
   - 否則 → 送至 **Codex**
5. **其他工具** (`Agent`、`Task`、`Cron*`、`NotebookEdit`、`EnterWorktree`、`ExitWorktree`、`Workflow`) → 送至 **Codex**

**Codex 審查**：
- 提示要求 Codex 只回覆 `SAFE` 或 `HUMAN`。
- 若 Codex 回覆 `SAFE` → **通過**
- 若 Codex 回覆 `HUMAN` → **詢問使用者**
- 若 Codex 未給出明確裁決（逾時、錯誤、空輸出） → 以相同的提示轉為 **DeepSeek API** 作為備援
- 若 DeepSeek 回覆 `SAFE` → **通過**
- 若 DeepSeek 回覆 `HUMAN` → **詢問使用者**
- 若兩者均未給出明確裁決 → **詢問使用者**（保守原則）

由於 `bypassPermissions` 已啟用，除非該回合明確返回 `HUMAN`，否則 hook 的 `ask` 決定 **不會** 顯示提示。實際上，這意味著：
- 大多數日常操作（編輯檔案、執行測試、非強制推送等）會自動獲得批准。
- 只有真正危險的操作（刪除大型樹枝、強制推送到主分支、寫入憑證等）才會觸發提示。

## 自訂

您可以通過編輯鉤檔案或環境變數來調整以下內容：

| 什麼 | 如何 |
|------|------|
| **DeepSeek 模型** | 變更 `codex-full-access-guard.js` 中 `callJudgeAPI` 函式內的模型名稱（目前為 `deepseek-chat`）。 |
| **逾時** | 修改 `codex-full-access-guard.js` 中的 `timeout` 值（Codex：12000 毫秒，DeepSeek：10000 毫秒）。 |
| **額外的僅讀命令** | 編輯 `codex-full-access-guard.js` 中的 `READ_ONLY_CMDS`、`READ_ONLY_GIT_SUB`、`READ_ONLY_GH_ACTION` 集合。 |
| **額外的危險 Git 模式** | 編輯 `dangerous-git-guard.js` 中的 `dangerousSegment` 函數。 |

## 解除安裝

要移除 Airlock 外掛程式：
1. 刪除資料夾 `~/.claude/plugins/cc-airlock/`。
2. 從 `~/.claude/settings.json` 中移除指向 `codex-full-access-guard.js` 的 `PreToolUse` 條目。
3. （可選）如果您不再需要，取消設定 `DEEPSEEK_API_KEY`。

## 授權

MIT © 2025 Your Name

如果您有改進的點子，請在 GitHub 上提出 issue 或提交 pull request！