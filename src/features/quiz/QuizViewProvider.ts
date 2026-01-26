import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getDiffForFile, getGitMetadata, countChangedLines } from '../../services/gitDiff';
import { OpenAIResponsesClient } from '../../services/openaiClient';
import { issueAttestation } from '../../services/attestationClient';
import { computeDiffHash, computeAnswersHash, computeQuestionSetHash } from '../token/token';
import { saveSession } from '../../services/storage';
import { redactSensitive } from '../../services/redact';
import type { DiffFile, QuizSet, SummaryGenerationResponse } from '../../types';

type WebviewMessage =
  | { type: 'getDiffFiles' }
  | { type: 'generateQuiz'; files: string[] }
  | { type: 'generateSummary'; files: string[] }
  | { type: 'submitAnswers'; answers: number[] };

const DEFAULT_EXCLUDED_GLOBS = [
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '**/*.min.js',
  '**/*.map',
  'dist/**',
  'build/**',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.pdf',
];

function desiredQuestionCount(totalChangedLines: number): number {
  if (totalChangedLines <= 30) return 3;
  if (totalChangedLines <= 120) return 5;
  return 8;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesGlob(filePath: string, glob: string): boolean {
  return globToRegExp(glob).test(filePath);
}

function normalizeRepoSlug(remoteUrl: string, fallback: string): string {
  if (!remoteUrl) {
    return fallback;
  }
  const httpsMatch = remoteUrl.match(
    /github\.com[:/](?<owner>[^/]+)\/(?<name>[^/.]+)(\.git)?$/
  );
  if (httpsMatch?.groups?.owner && httpsMatch.groups.name) {
    return `${httpsMatch.groups.owner}/${httpsMatch.groups.name}`;
  }
  return fallback;
}

function buildPrTemplate(token: string, attestationPath: string): string {
  return [
    '## 理解トークン',
    '',
    `- BANSOU: ${token}`,
    `- BANSOU-ATTESTATION: ${attestationPath}`,
    '',
  ].join('\n');
}

export class QuizViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'bansou.sidebar';

  private view?: vscode.WebviewView;
  private lastQuiz?: QuizSet;
  private lastFiles: string[] = [];
  private lastRepo = '';
  private lastBranch = '';
  private lastCommit = '';
  private lastUserName = '';
  private lastUserEmail = '';
  private lastDiffsByFile: Record<string, string> = {};
  private lastSummary?: SummaryGenerationResponse;
  private lastErrorQuiz?: QuizSet;
  private quizStartedAt?: number;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'ui', 'dist')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'getDiffFiles':
          await this.handleGetDiffFiles();
          return;
        case 'generateQuiz':
          await this.handleGenerateQuiz(message.files);
          return;
        case 'generateSummary':
          await this.handleGenerateSummary(message.files);
          return;
        case 'submitAnswers':
          await this.handleSubmitAnswers(message.answers);
          return;
        default:
          return;
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : 'Unknown error.';
      this.postMessage({ type: 'error', message: messageText });
    }
  }

  private async handleGetDiffFiles(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    const metadata = await getGitMetadata(workspaceRoot);
    this.lastRepo = normalizeRepoSlug(metadata.remoteUrl, path.basename(metadata.root));
    this.lastBranch = metadata.branch;
    this.lastCommit = metadata.commit;
    this.lastUserName = metadata.userName;
    this.lastUserEmail = metadata.userEmail;

    const config = this.getConfig();
    const excludeGlobs = config.excludeGlobs;
    const diffFiles: DiffFile[] = metadata.files.map((filePath) => ({
      path: filePath,
      isExcludedByDefault: excludeGlobs.some((pattern) =>
        matchesGlob(filePath, pattern)
      ),
    }));
    this.postMessage({
      type: 'diffFiles',
      diffFiles,
      repo: this.lastRepo,
      openAIMode: config.openAIMode,
    });
  }

  private async handleGenerateQuiz(files: string[]): Promise<void> {
    if (!files.length) {
      throw new Error('No files selected for quiz generation.');
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const diffsByFile: Record<string, string> = {};
    let totalChanged = 0;
    for (const filePath of files) {
      const diff = await getDiffForFile(workspaceRoot, filePath);
      diffsByFile[filePath] = diff;
      totalChanged += countChangedLines(diff);
    }
    this.lastDiffsByFile = diffsByFile;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set in the environment.');
    }

    const config = this.getConfig();
    const model = config.model;
    const client = new OpenAIResponsesClient(apiKey, model);
    const redactedDiffs: Record<string, string> = {};
    for (const filePath of files) {
      redactedDiffs[filePath] = redactSensitive(diffsByFile[filePath] ?? '');
    }

    const quizSet = await client.generateQuiz({
      files,
      diffsByFile: redactedDiffs,
      desiredQuestionCount:
        config.questionCount === 'auto'
          ? desiredQuestionCount(totalChanged)
          : config.questionCount,
      title: `Quiz for ${this.lastBranch || 'workspace'} @ ${new Date().toISOString()}`,
    });

    const shuffledQuiz = shuffleQuizOptions(quizSet);
    this.lastQuiz = shuffledQuiz;
    this.lastFiles = files;
    this.quizStartedAt = Date.now();
    this.postMessage({ type: 'quizSet', quizSet: shuffledQuiz });
  }

  async generateErrorQuizFromLine(errorLine: string): Promise<void> {
    const config = this.getConfig();
    if (config.openAIMode === 'localOnly') {
      const quizSet: QuizSet = {
        title: 'エラー原因クイズ（テンプレ）',
        questions: [
          {
            filePath: 'terminal',
            question: 'このエラーの原因として最も可能性が高いものはどれですか？',
            options: [
              '環境変数や秘密情報の未設定・不足',
              '依存関係の不足またはバージョン不一致',
              '入力や設定の形式ミス',
              'コードの未ビルド/反映漏れ',
            ],
            answerIndex: 0,
            rationale: 'テンプレのため、実際のログを確認して原因を特定してください。',
            hunkSummary: '',
          },
        ],
      };
      this.lastErrorQuiz = quizSet;
      this.postMessage({ type: 'errorQuizSet', quizSet, errorLine });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set in the environment.');
    }
    const client = new OpenAIResponsesClient(apiKey, config.model);
    const redacted = redactSensitive(errorLine);
    const quizSet = await client.generateErrorQuiz(redacted);
    this.lastErrorQuiz = quizSet;
    this.postMessage({ type: 'errorQuizSet', quizSet, errorLine });
  }

  private async handleGenerateSummary(files: string[]): Promise<void> {
    if (!files.length) {
      throw new Error('No files selected for summary generation.');
    }
    const workspaceRoot = this.getWorkspaceRoot();
    const diffsByFile: Record<string, string> = {};
    for (const filePath of files) {
      const diff = await getDiffForFile(workspaceRoot, filePath);
      diffsByFile[filePath] = diff;
    }
    const config = this.getConfig();
    if (config.openAIMode === 'localOnly') {
      const summaryLines = [
        '変更概要:',
        '- ここに要約を書いてください',
        '- 影響範囲と理由を簡潔に',
      ];
      const prDraft = [
        '## 変更内容',
        '- TODO: 変更点を箇条書きで記載',
        '',
        '## 動作確認',
        '- TODO: 実施したテスト',
        '',
        '## 補足',
        '- TODO: 影響範囲や注意点',
      ].join('\n');
      this.lastSummary = { summaryLines, prDraft };
      this.postMessage({ type: 'summaryResult', summaryLines, prDraft });
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set in the environment.');
    }
    const client = new OpenAIResponsesClient(apiKey, config.model);
    const redactedDiffs: Record<string, string> = {};
    for (const filePath of files) {
      redactedDiffs[filePath] = redactSensitive(diffsByFile[filePath] ?? '');
    }
    const result = await client.generateSummary({
      files,
      diffsByFile: redactedDiffs,
      title: `Summary for ${this.lastBranch || 'workspace'}`,
    });
    this.lastSummary = result;
    this.postMessage({
      type: 'summaryResult',
      summaryLines: result.summaryLines,
      prDraft: result.prDraft,
    });
  }

  private async handleSubmitAnswers(answers: number[]): Promise<void> {
    if (!this.lastQuiz) {
      throw new Error('Quiz has not been generated yet.');
    }
    const total = this.lastQuiz.questions.length;
    let correct = 0;
    this.lastQuiz.questions.forEach((question, index) => {
      if (answers[index] === question.answerIndex) {
        correct += 1;
      }
    });
    const score = total === 0 ? 0 : Math.round((correct / total) * 100);
    const passScore = this.getConfig().passScore;
    const passed = score >= passScore;
    const questionSetHash = computeQuestionSetHash(this.lastQuiz.questions);
    const diffHash = computeDiffHash(this.lastDiffsByFile);
    const answersHash = computeAnswersHash(answers);
    const config = this.getConfig();
    const issuer = this.getIssuer();
    let token = '';
    let prTemplate = '';
    let attestationPath = '';

    if (passed) {
      if (!config.attestationServerUrl) {
        throw new Error('attestationServerUrl is not set in settings or environment.');
      }
      if (!config.attestationSubject) {
        throw new Error('attestationSubject is not set in settings or environment.');
      }
      const durationMs = this.quizStartedAt ? Date.now() - this.quizStartedAt : undefined;
      const artifactPath =
        this.lastFiles.length === 1 ? this.lastFiles[0] : 'multiple-files';

      const response = await issueAttestation(config.attestationServerUrl, {
        sub: config.attestationSubject,
        repo: this.lastRepo,
        commit: this.lastCommit,
        artifact: { path: artifactPath },
        quiz_id: config.attestationQuizId,
        quiz_version: config.attestationQuizVersion,
        score,
        duration_ms: durationMs,
        questions_hash: questionSetHash,
        answers_hash: answersHash,
      });

      token = response.attestation_jwt;
      attestationPath = await this.writeAttestationFile(
        config.attestationSaveDir,
        this.lastCommit,
        config.attestationQuizId,
        token
      );
      prTemplate = buildPrTemplate(token, attestationPath);
    }

    await saveSession(this.context, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      repo: this.lastRepo,
      branch: this.lastBranch,
      commit: this.lastCommit,
      diffHash,
      issuer,
      files: this.lastFiles,
      questions: this.lastQuiz.questions,
      answers,
      score,
      token,
      questionSetHash,
      summary: this.lastSummary?.summaryLines,
      prDraft: this.lastSummary?.prDraft,
      prTemplate,
      attestationPath,
      answersHash,
    });

    this.postMessage({
      type: 'gradeResult',
      score,
      passed,
      token,
      prTemplate,
      attestationPath,
      correct,
      total,
    });
  }

  private postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  private getConfig(): {
    model: string;
    passScore: number;
    openAIMode: 'localOnly' | 'useOpenAI';
    excludeGlobs: string[];
    questionCount: 'auto' | number;
    terminalErrorQuiz: boolean;
    attestationServerUrl: string;
    attestationQuizId: string;
    attestationQuizVersion: string;
    attestationSubject: string;
    attestationSaveDir: string;
  } {
    const config = vscode.workspace.getConfiguration('understandingQuiz');
    const model = config.get<string>('model', 'gpt-5-mini');
    const passScore = config.get<number>('passScore', 80);
    const openAIMode = config.get<'localOnly' | 'useOpenAI'>(
      'openAIMode',
      'localOnly'
    );
    const excludeGlobs = config.get<string[]>(
      'excludeGlobs',
      DEFAULT_EXCLUDED_GLOBS
    );
    const questionCountRaw = config.get<'auto' | number | string>(
      'questionCount',
      'auto'
    );
    const questionCount =
      typeof questionCountRaw === 'number'
        ? questionCountRaw
        : questionCountRaw === 'auto'
          ? 'auto'
          : Number.isNaN(Number(questionCountRaw))
            ? 'auto'
            : Number(questionCountRaw);
    const terminalErrorQuiz = config.get<boolean>('terminalErrorQuiz', true);
    const attestationServerUrl =
      config.get<string>('attestationServerUrl', '') ||
      process.env.BANSOU_ATTEST_URL ||
      '';
    const attestationQuizId =
      config.get<string>('attestationQuizId', 'core-pr') ||
      process.env.BANSOU_ATTEST_QUIZ_ID ||
      'core-pr';
    const attestationQuizVersion =
      config.get<string>('attestationQuizVersion', '1.0.0') ||
      process.env.BANSOU_ATTEST_QUIZ_VERSION ||
      '1.0.0';
    const attestationSubject =
      config.get<string>('attestationSubject', '') ||
      process.env.BANSOU_ATTEST_SUB ||
      '';
    const attestationSaveDir =
      config.get<string>('attestationSaveDir', '.bansou/attestations') ||
      '.bansou/attestations';
    return {
      model,
      passScore,
      openAIMode,
      excludeGlobs,
      questionCount,
      terminalErrorQuiz,
      attestationServerUrl,
      attestationQuizId,
      attestationQuizVersion,
      attestationSubject,
      attestationSaveDir,
    };
  }

  private getIssuer(): string {
    if (this.lastUserName) {
      return this.lastUserName;
    }
    if (this.lastUserEmail) {
      return this.lastUserEmail;
    }
    return 'unknown';
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }

  private async writeAttestationFile(
    baseDir: string,
    commit: string,
    quizId: string,
    token: string
  ): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    const dir = path.join(workspaceRoot, baseDir, commit);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${quizId}.jwt`);
    await fs.promises.writeFile(filePath, token, 'utf8');
    return path.relative(workspaceRoot, filePath);
  }

  private getHtml(webview: vscode.Webview): string {
    const manifestPath = vscode.Uri.joinPath(
      this.extensionUri,
      'ui',
      'dist',
      '.vite',
      'manifest.json'
    );
    if (!fs.existsSync(manifestPath.fsPath)) {
      return `<!DOCTYPE html>
<html lang="en">
  <body>
    <h2>Webview build missing</h2>
    <p>Run <code>npm install</code> and <code>npm run build</code> in the <code>ui</code> folder.</p>
  </body>
</html>`;
    }
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath.fsPath, 'utf8')
    ) as Record<string, { file: string; css?: string[] }>;
    const entry =
      manifest['src/main.tsx'] ?? manifest['main'];
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'ui', 'dist', entry.file)
    );
    const styleUri = entry.css?.[0]
      ? webview.asWebviewUri(
          vscode.Uri.joinPath(this.extensionUri, 'ui', 'dist', entry.css[0])
        )
      : undefined;

    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${styleUri ? `<link rel="stylesheet" href="${styleUri}">` : ''}
    <title>BANSOU</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function shuffleQuizOptions(quizSet: QuizSet): QuizSet {
  const questions = quizSet.questions.map((question) => {
    const indexedOptions = question.options.map((option, index) => ({
      option,
      index,
    }));
    for (let i = indexedOptions.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indexedOptions[i], indexedOptions[j]] = [
        indexedOptions[j],
        indexedOptions[i],
      ];
    }
    const newOptions = indexedOptions.map((item) => item.option) as [
      string,
      string,
      string,
      string,
    ];
    const newAnswerIndex = indexedOptions.findIndex(
      (item) => item.index === question.answerIndex
    );
    return {
      ...question,
      options: newOptions,
      answerIndex: newAnswerIndex,
    };
  });
  return { ...quizSet, questions };
}
