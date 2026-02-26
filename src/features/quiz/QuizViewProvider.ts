import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { getDiffForFile, getGitMetadata, countChangedLines } from '../../services/gitDiff';
import { OpenAIResponsesClient } from '../../services/openaiClient';
import { issueAttestation } from '../../services/attestationClient';
import {
  generateServerQuiz,
  submitServerQuiz,
  QuizArtifact,
} from '../../services/quizClient';
import { computeDiffHash, computeAnswersHash, computeQuestionSetHash } from '../token/token';
import { saveSession } from '../../services/storage';
import { redactSensitive } from '../../services/redact';
import type { DiffFile, QuizSet, SummaryGenerationResponse } from '../../types';

type WebviewMessage =
  | { type: 'getDiffFiles' }
  | { type: 'generateQuiz'; files: string[] }
  | { type: 'generateSummary'; files: string[] }
  | { type: 'generateChecklist'; files: string[] }
  | { type: 'issueChecklistToken'; path?: string }
  | { type: 'openChecklist'; path?: string }
  | { type: 'submitAnswers'; answers: number[] };

const DEFAULT_EXCLUDED_GLOBS = [
  '.bansou/**',
  '**/*.jwt',
  '**/checklist-*.md',
  '**/*.md',
  '**/*.markdown',
  '**/*.json',
  '**/*.yml',
  '**/*.yaml',
  '**/*.toml',
  '**/*.ini',
  '**/*.cfg',
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

const HARD_EXCLUDED_GLOBS = [
  '.bansou/**',
  '**/*.jwt',
  '**/*.md',
  '**/*.markdown',
  '**/*.json',
  '**/*.yml',
  '**/*.yaml',
  '**/*.toml',
  '**/*.ini',
  '**/*.cfg',
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

type ChecklistInput = {
  repo: string;
  branch: string;
  commit: string;
  files: string[];
  diffsByFile: Record<string, string>;
  minChecked: number;
};

type ChecklistProgress = {
  checked: number;
  total: number;
};

type DiffRange = {
  rangeStart: number;
  rangeEnd: number;
};

type IssuedAttestation = {
  token: string;
  attestationPath: string;
  artifactPath: string;
  rangeStart?: number;
  rangeEnd?: number;
};

function computeChecklistHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('base64url');
}

function extractChecklistProgress(markdown: string): ChecklistProgress {
  const lines = markdown.split(/\r?\n/);
  let checked = 0;
  let total = 0;
  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[(?<state>[xX\s])\]\s+/);
    if (!match?.groups?.state) continue;
    total += 1;
    if (match.groups.state.toLowerCase() === 'x') {
      checked += 1;
    }
  }
  return { checked, total };
}

function countDiffLines(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function extractChangedRanges(diffText: string): DiffRange[] {
  const ranges: DiffRange[] = [];
  const lines = diffText.split('\n');
  for (const line of lines) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] ? Number(match[2]) : 1;
    const end = length > 0 ? start + length - 1 : start;
    ranges.push({ rangeStart: start, rangeEnd: end });
  }
  return ranges;
}

function buildArtifactsForFiles(
  files: string[],
  diffsByFile: Record<string, string>
): QuizArtifact[] {
  const artifacts: QuizArtifact[] = [];
  for (const filePath of files) {
    const ranges = extractChangedRanges(diffsByFile[filePath] ?? '');
    if (ranges.length === 0) {
      artifacts.push({ path: filePath });
      continue;
    }
    for (const range of ranges) {
      artifacts.push({
        path: filePath,
        rangeStart: range.rangeStart,
        rangeEnd: range.rangeEnd,
      });
    }
  }
  return artifacts;
}

function buildAttestationSuffix(
  artifactPath: string,
  rangeStart?: number,
  rangeEnd?: number
): string {
  const hashInput = `${artifactPath}:${rangeStart ?? ''}:${rangeEnd ?? ''}`;
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
  if (rangeStart !== undefined && rangeEnd !== undefined) {
    return `f-${hash}-L${rangeStart}-${rangeEnd}`;
  }
  return `f-${hash}`;
}

function buildPrTemplate(attestations: IssuedAttestation[]): string {
  const primary = attestations[0];
  if (!primary) {
    return '';
  }
  return [
    '## 理解トークン',
    '',
    `- BANSOU: ${primary.token}`,
    `- BANSOU-ATTESTATION: ${primary.attestationPath}`,
    '',
    '### Attestation Artifacts',
    ...attestations.map((entry) => {
      const rangeLabel =
        entry.rangeStart !== undefined && entry.rangeEnd !== undefined
          ? ` (L${entry.rangeStart}-L${entry.rangeEnd})`
          : '';
      return `- ${entry.artifactPath}${rangeLabel}: ${entry.attestationPath}`;
    }),
    '',
  ].join('\n');
}

function buildChecklistMarkdown(input: ChecklistInput): string {
  const createdAt = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# 理解チェックシート');
  lines.push('');
  lines.push('## メタ情報');
  lines.push(`- 生成日時: ${createdAt}`);
  lines.push(`- リポジトリ: ${input.repo || 'workspace'}`);
  lines.push(`- ブランチ: ${input.branch || 'unknown'}`);
  lines.push(`- コミット: ${input.commit || 'unknown'}`);
  lines.push(`- 対象ファイル数: ${input.files.length}`);
  lines.push('');
  lines.push('## 使い方');
  lines.push(
    `- 各項目を確認したら \`[x]\` にチェックを入れてください（最低チェック数: ${input.minChecked}）`
  );
  lines.push('- 未記入の自由記述欄は、必要に応じて埋めてください');
  lines.push('');
  lines.push('## 変更ファイル別の確認');
  lines.push('');

  for (const filePath of input.files) {
    const diff = input.diffsByFile[filePath] ?? '';
    const { added, removed } = countDiffLines(diff);
    lines.push(`### ${filePath}`);
    lines.push(`- 追加行: ${added} / 削除行: ${removed}`);
    lines.push('- [ ] このファイルの変更目的を1文で説明した');
    lines.push('- [ ] 主要なロジック・挙動の変更点を把握した');
    lines.push('- [ ] 影響範囲（呼び出し元/依存/互換性）を確認した');
    lines.push('- [ ] 例外/エッジケースやエラー処理を確認した');
    lines.push('- [ ] テスト/動作確認の内容を確認した');
    lines.push('');
    lines.push('自由記述:');
    lines.push('- 変更の要約: ');
    lines.push('- 注意点/懸念: ');
    lines.push('');
  }

  lines.push('## まとめ');
  lines.push('- [ ] 変更全体の目的と影響を説明できる');
  lines.push('- [ ] ロールバック/フォールバック手順を理解した');
  lines.push('');
  lines.push('自由記述:');
  lines.push('- 全体メモ: ');
  lines.push('');
  return lines.join('\n');
}

function buildLocalQuizSet(
  files: string[],
  diffsByFile: Record<string, string>,
  desiredCount: number,
  title: string
): QuizSet {
  const questions = files.slice(0, Math.max(1, desiredCount)).map((filePath) => {
    const diff = diffsByFile[filePath] ?? '';
    const changedLines = countChangedLines(diff);
    const options: [string, string, string, string] = [
      '変更目的と影響範囲を説明できる状態',
      'ファイル名だけ把握している状態',
      '動作確認せずにマージできる状態',
      '差分を見ずに推測でレビューする状態',
    ];
    return {
      filePath,
      question: `${filePath} の変更をレビューする上で最も適切な姿勢はどれですか？`,
      options,
      answerIndex: 0,
      rationale: `このファイルの検出変更行数は ${changedLines} 行です。目的・影響・確認内容を言語化できる状態を目標にしてください。`,
      hunkSummary: `Detected changed lines: ${changedLines}`,
    };
  });

  return {
    title: `${title} (local template)`,
    questions,
  };
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
  private lastChecklistPath?: string;
  private lastChecklistFiles: string[] = [];
  private lastChecklistDiffsByFile: Record<string, string> = {};
  private checklistStartedAt?: number;
  private lastQuizSessionToken = '';
  private lastServerQuestionsHash = '';
  private lastServerDiffHash = '';

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
        case 'generateChecklist':
          await this.handleGenerateChecklist(message.files);
          return;
        case 'issueChecklistToken':
          await this.handleIssueChecklistToken(message.path);
          return;
        case 'openChecklist':
          await this.handleOpenChecklist(message.path);
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
      void vscode.window.showErrorMessage(`BANSOU: ${messageText}`);
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
    this.lastQuizSessionToken = '';
    this.lastServerQuestionsHash = '';
    this.lastServerDiffHash = '';

    const config = this.getConfig();
    const excludeGlobs = config.excludeGlobs;
    const diffFiles: DiffFile[] = metadata.files
      .filter((filePath) =>
        !HARD_EXCLUDED_GLOBS.some((pattern) => matchesGlob(filePath, pattern))
      )
      .map((filePath) => ({
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
    this.lastQuizSessionToken = '';
    this.lastServerQuestionsHash = '';
    this.lastServerDiffHash = '';

    const config = this.getConfig();
    if (config.attestationServerUrl && config.attestationSubject) {
      try {
        const desiredCount =
          config.questionCount === 'auto'
            ? desiredQuestionCount(totalChanged)
            : config.questionCount;
        const artifacts = buildArtifactsForFiles(files, diffsByFile);
        const response = await generateServerQuiz(config.attestationServerUrl, {
          sub: config.attestationSubject,
          repo: this.lastRepo,
          commit: this.lastCommit,
          quiz_id: config.attestationQuizId,
          quiz_version: config.attestationQuizVersion,
          files,
          diffsByFile,
          desiredQuestionCount: desiredCount,
          artifacts,
        });
        const quizSet: QuizSet = {
          title: response.quiz.title,
          questions: response.quiz.questions.map((question) => ({
            ...question,
            answerIndex: undefined,
          })),
        };
        this.lastQuizSessionToken = response.quiz_session_token;
        this.lastServerQuestionsHash = response.questions_hash;
        this.lastServerDiffHash = response.diff_hash;
        const shuffledQuiz = shuffleQuizOptions(quizSet);
        this.lastQuiz = shuffledQuiz;
        this.lastFiles = files;
        this.quizStartedAt = Date.now();
        this.postMessage({ type: 'quizSet', quizSet: shuffledQuiz });
        return;
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : 'Unknown quiz generation error';
        void vscode.window.showWarningMessage(
          `BANSOU: server quiz failed, fallback to local mode (${messageText})`
        );
      }
    }

    const shouldUseLocalQuiz = config.openAIMode === 'localOnly' || !process.env.OPENAI_API_KEY;
    if (shouldUseLocalQuiz) {
      const quizSet = buildLocalQuizSet(
        files,
        diffsByFile,
        config.questionCount === 'auto'
          ? desiredQuestionCount(totalChanged)
          : config.questionCount,
        `Quiz for ${this.lastBranch || 'workspace'} @ ${new Date().toISOString()}`
      );
      const shuffledQuiz = shuffleQuizOptions(quizSet);
      this.lastQuiz = shuffledQuiz;
      this.lastFiles = files;
      this.quizStartedAt = Date.now();
      this.postMessage({ type: 'quizSet', quizSet: shuffledQuiz });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY as string;
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

  private async handleGenerateChecklist(files: string[]): Promise<void> {
    if (!files.length) {
      throw new Error('チェックシート生成の対象ファイルを選択してください。');
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const diffsByFile: Record<string, string> = {};
    for (const filePath of files) {
      const diff = await getDiffForFile(workspaceRoot, filePath);
      diffsByFile[filePath] = diff;
    }

    const config = this.getConfig();
    const checklistMarkdown = buildChecklistMarkdown({
      repo: this.lastRepo,
      branch: this.lastBranch,
      commit: this.lastCommit,
      files,
      diffsByFile,
      minChecked: config.checklistMinChecked,
    });
    const checklistPath = await this.writeChecklistFile(
      config.checklistSaveDir,
      this.lastCommit,
      checklistMarkdown
    );

    this.lastChecklistPath = checklistPath;
    this.lastChecklistFiles = files;
    this.lastChecklistDiffsByFile = diffsByFile;
    this.checklistStartedAt = Date.now();

    await this.openChecklistFile(checklistPath);

    const progress = extractChecklistProgress(checklistMarkdown);
    this.postMessage({
      type: 'checklistReady',
      path: checklistPath,
      checked: progress.checked,
      total: progress.total,
      minChecked: config.checklistMinChecked,
    });
  }

  private async handleIssueChecklistToken(pathOverride?: string): Promise<void> {
    const checklistPath = pathOverride ?? this.lastChecklistPath;
    if (!checklistPath) {
      throw new Error('チェックシートが作成されていません。');
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const absolutePath = path.join(workspaceRoot, checklistPath);
    const markdown = await fs.promises.readFile(absolutePath, 'utf8');
    const progress = extractChecklistProgress(markdown);

    const config = this.getConfig();
    if (progress.checked < config.checklistMinChecked) {
      throw new Error(
        `チェック済みが不足しています（${progress.checked}/${config.checklistMinChecked}）。`
      );
    }

    if (!config.attestationServerUrl) {
      throw new Error('attestationServerUrl is not set in settings or environment.');
    }
    if (!config.attestationSubject) {
      throw new Error('attestationSubject is not set in settings or environment.');
    }

    const durationMs = this.checklistStartedAt
      ? Date.now() - this.checklistStartedAt
      : undefined;
    const artifactPath = checklistPath;
    const checklistHash = computeChecklistHash(markdown);
    const diffHash = computeDiffHash(this.lastChecklistDiffsByFile);
    const score = progress.total
      ? Math.round((progress.checked / progress.total) * 100)
      : 100;

    const response = await issueAttestation(config.attestationServerUrl, {
      sub: config.attestationSubject,
      repo: this.lastRepo,
      commit: this.lastCommit,
      artifact: { path: artifactPath },
      quiz_id: config.attestationQuizId,
      quiz_version: config.attestationQuizVersion,
      score,
      duration_ms: durationMs,
      questions_hash: checklistHash,
      answers_hash: diffHash,
    });

    const token = response.attestation_jwt;
    const attestationPath = await this.writeChecklistAttestationFile(
      config.attestationSaveDir,
      this.lastCommit,
      config.attestationQuizId,
      token
    );

    this.postMessage({
      type: 'checklistTokenIssued',
      token,
      attestationPath,
      checked: progress.checked,
      total: progress.total,
    });
  }

  private async handleOpenChecklist(pathOverride?: string): Promise<void> {
    const checklistPath = pathOverride ?? this.lastChecklistPath;
    if (!checklistPath) {
      throw new Error('チェックシートが作成されていません。');
    }
    await this.openChecklistFile(checklistPath);
  }

  private async handleSubmitAnswers(answers: number[]): Promise<void> {
    if (!this.lastQuiz) {
      throw new Error('Quiz has not been generated yet.');
    }
    const config = this.getConfig();
    const total = this.lastQuiz.questions.length;
    let correct = 0;
    let score = 0;
    let passed = false;
    let questionSetHash = computeQuestionSetHash(this.lastQuiz.questions);
    let diffHash = computeDiffHash(this.lastDiffsByFile);
    const answersHash = computeAnswersHash(answers);
    const issuer = this.getIssuer();
    let token = '';
    let prTemplate = '';
    let attestationPath = '';
    let issuedAttestations: IssuedAttestation[] = [];

    if (this.lastQuizSessionToken && config.attestationServerUrl) {
      const durationMs = this.quizStartedAt ? Date.now() - this.quizStartedAt : undefined;
      const response = await submitServerQuiz(config.attestationServerUrl, {
        quiz_session_token: this.lastQuizSessionToken,
        answers,
        duration_ms: durationMs,
      });
      score = response.score;
      correct = response.correct;
      passed = response.passed;
      questionSetHash = response.questions_hash || this.lastServerQuestionsHash || questionSetHash;
      diffHash = response.diff_hash || this.lastServerDiffHash || diffHash;

      if (passed) {
        for (const attestation of response.attestations) {
          const artifactPath = attestation.artifact.path;
          let issuedPath = 'server-ledger';
          if (config.proofStorageMode === 'repository') {
            issuedPath = await this.writeAttestationFile(
              config.attestationSaveDir,
              this.lastCommit,
              config.attestationQuizId,
              attestation.attestation_jwt,
              buildAttestationSuffix(
                artifactPath,
                attestation.artifact.rangeStart,
                attestation.artifact.rangeEnd
              )
            );
          }
          issuedAttestations.push({
            token: attestation.attestation_jwt,
            attestationPath: issuedPath,
            artifactPath,
            rangeStart: attestation.artifact.rangeStart,
            rangeEnd: attestation.artifact.rangeEnd,
          });
        }
      }
    } else {
      this.lastQuiz.questions.forEach((question, index) => {
        if (question.answerIndex !== undefined && answers[index] === question.answerIndex) {
          correct += 1;
        }
      });
      score = total === 0 ? 0 : Math.round((correct / total) * 100);
      const passScore = config.passScore;
      passed = score >= passScore;
    }

    if (passed) {
      if (issuedAttestations.length === 0) {
        if (!config.attestationServerUrl) {
          throw new Error('attestationServerUrl is not set in settings or environment.');
        }
        if (!config.attestationSubject) {
          throw new Error('attestationSubject is not set in settings or environment.');
        }
        const durationMs = this.quizStartedAt ? Date.now() - this.quizStartedAt : undefined;
        for (const filePath of this.lastFiles) {
          const ranges = extractChangedRanges(this.lastDiffsByFile[filePath] ?? '');
          if (ranges.length === 0) {
            const response = await issueAttestation(config.attestationServerUrl, {
              sub: config.attestationSubject,
              repo: this.lastRepo,
              commit: this.lastCommit,
              artifact: { path: filePath },
              quiz_id: config.attestationQuizId,
              quiz_version: config.attestationQuizVersion,
              score,
              duration_ms: durationMs,
              questions_hash: questionSetHash,
              answers_hash: answersHash,
            });
            const issuedToken = response.attestation_jwt;
            const issuedPath = await this.writeAttestationFile(
              config.attestationSaveDir,
              this.lastCommit,
              config.attestationQuizId,
              issuedToken,
              buildAttestationSuffix(filePath)
            );
            issuedAttestations.push({
              token: issuedToken,
              attestationPath: issuedPath,
              artifactPath: filePath,
            });
            continue;
          }

          for (const range of ranges) {
            const response = await issueAttestation(config.attestationServerUrl, {
              sub: config.attestationSubject,
              repo: this.lastRepo,
              commit: this.lastCommit,
              artifact: {
                path: filePath,
                rangeStart: range.rangeStart,
                rangeEnd: range.rangeEnd,
              },
              quiz_id: config.attestationQuizId,
              quiz_version: config.attestationQuizVersion,
              score,
              duration_ms: durationMs,
              questions_hash: questionSetHash,
              answers_hash: answersHash,
            });
            const issuedToken = response.attestation_jwt;
            const issuedPath = await this.writeAttestationFile(
              config.attestationSaveDir,
              this.lastCommit,
              config.attestationQuizId,
              issuedToken,
              buildAttestationSuffix(filePath, range.rangeStart, range.rangeEnd)
            );
            issuedAttestations.push({
              token: issuedToken,
              attestationPath: issuedPath,
              artifactPath: filePath,
              rangeStart: range.rangeStart,
              rangeEnd: range.rangeEnd,
            });
          }
        }
      }

      if (issuedAttestations.length === 0) {
        throw new Error('No attestations were issued for selected files.');
      }

      token = issuedAttestations[0].token;
      attestationPath = issuedAttestations[0].attestationPath;
      prTemplate = buildPrTemplate(issuedAttestations);
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
    checklistSaveDir: string;
    checklistMinChecked: number;
    proofStorageMode: 'serverOnly' | 'repository';
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
    const checklistSaveDir =
      config.get<string>('checklistSaveDir', '.bansou/checklists') ||
      '.bansou/checklists';
    const checklistMinChecked = config.get<number>('checklistMinChecked', 0);
    const proofStorageMode = config.get<'serverOnly' | 'repository'>(
      'proofStorageMode',
      'serverOnly'
    );
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
      checklistSaveDir,
      checklistMinChecked,
      proofStorageMode,
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
    token: string,
    suffix = ''
  ): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    const dir = path.join(workspaceRoot, baseDir, commit);
    await fs.promises.mkdir(dir, { recursive: true });
    const fileName = suffix ? `${quizId}-${suffix}.jwt` : `${quizId}.jwt`;
    const filePath = path.join(dir, fileName);
    await fs.promises.writeFile(filePath, token, 'utf8');
    return path.relative(workspaceRoot, filePath);
  }

  private async writeChecklistAttestationFile(
    baseDir: string,
    commit: string,
    quizId: string,
    token: string
  ): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    const dir = path.join(workspaceRoot, baseDir, commit);
    await fs.promises.mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${quizId}-checklist-${timestamp}.jwt`);
    await fs.promises.writeFile(filePath, token, 'utf8');
    return path.relative(workspaceRoot, filePath);
  }

  private async writeChecklistFile(
    baseDir: string,
    commit: string,
    content: string
  ): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    const dir = path.join(workspaceRoot, baseDir, commit || 'workspace');
    await fs.promises.mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `checklist-${timestamp}.md`);
    await fs.promises.writeFile(filePath, content, 'utf8');
    return path.relative(workspaceRoot, filePath);
  }

  private async openChecklistFile(checklistPath: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    const filePath = path.join(workspaceRoot, checklistPath);
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document, { preview: false });
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
    ) as Record<string, { file: string; css?: string[]; imports?: string[] }>;
    const entry = manifest['src/main.tsx'] ?? manifest['main'];
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'ui', 'dist', entry.file)
    );
    const styleUris = collectStyleUris(manifest, entry).map((file) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'ui', 'dist', file)
      )
    );

    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${styleUris.map((uri) => `<link rel="stylesheet" href="${uri}">`).join('')}
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

function collectStyleUris(
  manifest: Record<string, { css?: string[]; imports?: string[] }>,
  entry: { css?: string[]; imports?: string[] }
): string[] {
  const cssFiles = new Set<string>();
  entry.css?.forEach((file) => cssFiles.add(file));
  entry.imports?.forEach((importKey) => {
    const imported = manifest[importKey];
    imported?.css?.forEach((file) => cssFiles.add(file));
  });
  return Array.from(cssFiles);
}
