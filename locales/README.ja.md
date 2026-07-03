# Claude Code Airlock

![GitHub リポジトリのサイズ](https://img.shields.io/github/repo-size/nurockplayer/cc-airlock)
![GitHub](https://img.shields.io/github/license/nurockplayer/cc-airlock)
![GitHub イシュー](https://img.shields.io/github/issues/nurockplayer/cc-airlock)
![GitHub スター](https://img.shields.io/github/stars/nurockplayer/cc-airlock?style=social)

**タグライン**: Claude Code `bypassPermissions` 用 Codex 駆動型リスクレビュー

[English] | [日本語] | [繁體中文] | [한국어]

## 何ができるのか？

`bypassPermissions` を有効にすると、Claude Code はすべての `ask` 権限を自動的に許可します—つまり、`git push`、`npm install`、ファイル書き込みなどの潜在的にリスクのあるコマンドを実行する際に、確認を求めるプロンプトが表示されなくなります。

このプラグインは安全レイヤーを復元します：**読み取り専用でも書き込みでもないすべての操作は、まず Codex （バックアップとして DeepSeek）によってリスク評価されます**。そして、**Codex と DeepSeek の両方が明確に `HUMAN` を返した場合のみ**、Claude は確認のために一時停止します。それ以外の場合、操作は自動的に続行されます。

簡単に言うと：
- ✅ 読み取り専用ツール（Read、Grep、Glob、TaskList、WebFetch、…）→ **即座にパス**
- ⚠️ 書き込みツール（Write、Edit、MultiEdit）→ **Codex レビュー → DeepSeek フォールバック → 両方が HUMAN の場合のみ問い合わせ**
- ⚠️ その他すべて（Bash、Agent、Task、Cron* …）→ **Codex レビュー → DeepSeek フォールバック → 両方が HUMAN の場合のみ問い合わせ**

これにより、`bypassPermissions` のスピードを享受しつつ、本当に危険な操作（例：`rm -rf /`、`git push --force`、機密ファイルの書き込み）を実行前に捕捉できます。

## インストール

### 前提条件
- `bypassPermissions` が有効になっている Claude Code（`settings.json` で `"permissionMode": "bypassPermissions"` を確認してください）
- Node.js（フックで使用します）
- （オプション）フォールバック用の DeepSeek API キー。環境変数 `DEEPSEEK_API_KEY` を設定してください。設定されていない場合でもプラグインは動作しますが、Codex が不確かなときにのみあなたに尋ねます。

### ワンラインインストール

```bash
git clone https://github.com/nurockplayer/cc-airlock.git
cd cc-airlock
chmod +x scripts/install.sh
./scripts/install.sh
```

インストーラーは以下を行います：
1. フックスクリプトを `~/.claude/plugins/cc-airlock/hooks/` にコピーします
2. 既に設定されていない場合は、`~/.claude/settings.json` に `"permissionMode": "bypassPermissions"` を追加するよう促します
3. すべての関連ツールタイプに対して Airlock ガードを実行する `PreToolUse` フックを追加します
4. `~/.claude/CLAUDE.md` に最終レポート二重報告ルールを追加します（各タスク完了後に Claude 自身のレポートと Codex のレビューレポートの両方を必ず報告するルール）

### 手動インストール（お好みで）

1. `hooks/` フォルダーを `~/.claude/plugins/cc-airlock/` にコピーします
2. `~/.claude/settings.json` が次のように含まれていることを確認してください：
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
3. （オプション）あなたの DeepSeek キーをエクスポートします：
   ```bash
   export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   シェルのプロファイルに追加して、Claude Code からアクセスできるようにしてください。

4. 二重報告ルールを `~/.claude/CLAUDE.md` に追加します（ファイルが存在しない場合は新規作成）。
   既に `## 最終回報雙軌制` の見出しまたは同等の内容が存在する場合は、この手順をスキップしてください。

   以下の内容を追記してください：

   ```markdown
   ## 最終回報雙軌制

   每輪任務完成後，最終回報必須同時包含兩份報告，缺一不可：

   1. **Claude 自身回報**：變更摘要、驗證結果、殘餘風險
   2. **Codex 審查回報**：Spec Compliance（規格遵循性）+ Spec Adequacy（規格充足性）雙重驗證結果，含最終裁決（SAFE / must-fix）

   兩份報告寫入工作目錄的 `memory/last-report.md`（若 `memory/` 目錄不存在則先建立）。
   ```

## 仕組み

ツールリクエストが届くと：

1. **組み込み読み取り専用ツール**ール**ール (`Read`, `Grep`, `Glob`, `TaskList`, `TaskGet`, `TaskOutput`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `WebFetch`, `WebSearch`, `CronList`, `Skill`, `Plan`, `NotebookRead`) → **即座にパス**
2. **書き込みツール** (`Write`, `Edit`, `MultiEdit`) → **Codex レビュー → DeepSeek フォールバック → 両方が HUMAN の場合のみ問い合わせ**
3. **MCP 読み取り専用ツール** （`mcp__.+__ (read|list|…)` に一致するもの） → **即座にパス**
4. **Bash コマンド**：
   - コマンドが厳格な読み取り専用ホワイトリストと一致する場合（例：`git status`、`ls`、`cat`、パイプライン） → **即座にパス**
   - それ以外の場合 → **Codex** に送信
5. **その他のツール** (`Agent`、`Task`、`Cron*`、`NotebookEdit`、`EnterWorktree`、`ExitWorktree`、`Workflow`) → **Codex** に送信

**Codex レビュー**：
- プロンプトは Codex に `SAFE` または `HUMAN` のみを返答するよう要求します
- Codex が `SAFE` を返信 → **パス**
- Codex が `HUMAN` を返信 → **ユーザーに確認を求めます**
- Codex が明確な verdict を返さない（タイムアウト、エラー、空の出力）場合 → 同じプロンプトで **DeepSeek API** にフォールバックします
- DeepSeek が `SAFE` を返信 → **パス**
- DeepSeek が `HUMAN` を返信 → **ユーザーに確認を求めます**
- 両方が明確な verdict を返さない場合 → **ユーザーに確認を求めます**（保守的）

`bypassPermissions` が有効なため、フックからの `ask` 決定は、フックが明示的に `HUMAN` を返す場合のみプロンプトが表示されます。実際には、これは次のことを意味します：
- ほとんどの日常的な操作（ファイルの編集、テストの実行、非フォースプッシュなど）は自動的に承認されます
- 本当に危険な操作（大きなツリーの削除、メインへのフォースプッシュ、認証情報の書き込みなど）のみがプロンプトをトリガーします

## カスタマイズ

次の項目をフックファイルまたは環境で調整できます：

| 何を | どうするか |
|------|------------|
| **DeepSeek モデル** | `codex-full-access-guard.js` 内の `callJudgeAPI` でモデル名を変更します（現在 `deepseek-chat`） |
| **タイムアウト** | `codex-full-access-guard.js` の `timeout` 値を変更します（Codex: 12000 ms、DeepSeek: 10000 ms） |
| **追加の読み取り専用コマンド** | `codex-full-access-guard.js` の `READ_ONLY_CMDS`、`READ_ONLY_GIT_SUB`、`READ_ONLY_GH_ACTION` セットを編集します |
| **追加の危険な Git パターン** | `dangerous-git-guard.js` の `dangerousSegment` 関数を編集します |

## アンインストール

Airlock プラグインを削除するには：
1. フォルダー `~/.claude/plugins/cc-airlock/` を削除します
2. `~/.claude/settings.json` から `codex-full-access-guard.js` を指す `PreToolUse` エントリを削除します
3. （オプション）`DEEPSEEK_API_KEY` が不要な場合は解除します

## ライセンス

MIT © 2025 Your Name

改善のためのアイデアがある場合は、GitHub で issue を開いたりプルリクエストを送信したりしてください！