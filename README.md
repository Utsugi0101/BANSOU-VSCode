# BANSOU

Git diff から理解確認クイズを生成し、解説と理解トークンを発行する VS Code 拡張です。

## Features

- git diff からクイズ生成（選択式）
- 回答・採点・トークン発行
- 解説（rationale）表示
- 変更要約 / PR説明文の下書き生成（OpenAI またはローカルテンプレ）
- PR へ貼り付けやすいトークンテンプレをコピー

## Requirements

- Node.js 18+
- Workspace が git repo であること
- OpenAI 利用時は `OPENAI_API_KEY`
- Attestation 発行サーバの設定（`attestationServerUrl` / `BANSOU_ATTEST_URL`）
- Attestation の subject 設定（`attestationSubject` / `BANSOU_ATTEST_SUB`）

## Setup

1) 依存関係
```
npm install
```

2) Webview UI のビルド
```
cd ui
npm install
npm run build
```

3) 環境変数（`.env` でも可）
```
OPENAI_API_KEY=your-key
BANSOU_ATTEST_URL=https://attest.example.com
BANSOU_ATTEST_SUB=your-github-login
```

## Run in VS Code

- `F5` で Extension Development Host を起動
- コマンドパレットで `BANSOU: Open Sidebar`

## Terminal Error Quiz (Dev Mode)

ターミナルのエラー検知は提案API `terminalDataWriteEvent` を使います。  
Extension Development Host の起動引数で `--enable-proposed-api undefined_publisher.bansou` を指定してください。

## Settings

- `understandingQuiz.model`: OpenAI model name
- `understandingQuiz.openAIMode`: `localOnly` or `useOpenAI`
- `understandingQuiz.excludeGlobs`: 除外 glob
- `understandingQuiz.questionCount`: `auto` or number
- `understandingQuiz.passScore`: 合格点
- `understandingQuiz.attestationServerUrl`: Attestation サーバのURL
- `understandingQuiz.attestationSubject`: `sub`（GitHub ログイン推奨）
- `understandingQuiz.attestationQuizId`: `quiz_id`
- `understandingQuiz.attestationQuizVersion`: `quiz_version`
- `understandingQuiz.attestationSaveDir`: JWTの保存先
- `understandingQuiz.tokenSecretSource`: `envOnly`
- `understandingQuiz.githubIntegration`: `off` | `copyTemplate` | `postComment`
- `understandingQuiz.terminalErrorQuiz`: ターミナルのエラー検知クイズ（true/false）

> Note: attestation サーバ側で最小スコアが 80 に設定されているため、`passScore` は 80 以上に合わせるのを推奨します。

## GitHub Action (Required Check)

1) Workflow 追加  
`.github/workflows/verify-understanding-token.yml` を有効化

2) 必要ならスコア閾値を設定  
Repository Variables に `BANSOU_MIN_SCORE` を設定（サーバ側の設定に合わせる）

3) ブランチ保護で Required Check を有効化  
`Verify BANSOU Token` を Required Check に追加

## 手動テスト手順（Phase 1）

- 変更を作る → サイドバーで `git diff 取得`
- ファイル選択 → `クイズ生成`
- 回答 → `提出`
- 結果と解説表示、トークン/PRテンプレのコピーを確認
- 要約/PR下書き生成（localOnly ならテンプレが出る）

## 手動テスト手順（Phase 2）

- `.bansou/attestations/<commit>/<quiz_id>.jwt` が作成されていることを確認
- その JWT ファイルをコミットしてPRに含める
- Workflow が成功することを確認

## ターミナルエラー理解クイズ（MVP）

- ターミナルでエラーが出ると通知が出る
- 「クイズを作成」を押すと、エラー原因クイズがサイドバーに表示される

## Security / Privacy (MVP)

- OpenAI には選択された差分のみ送信
- `OPENAI_API_KEY` などのパターンは簡易マスク
