import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import { QuizViewProvider } from './features/quiz/QuizViewProvider';
import { openOfficialDocs } from './features/docs/openOfficialDocs';
import { DocsWebviewViewProvider } from './features/docs/DocsWebviewViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('BANSOU');
  output.appendLine('BANSOU activate');
  loadDotEnv();
  const provider = new QuizViewProvider(context, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QuizViewProvider.viewId, provider)
  );
  context.subscriptions.push(registerTerminalErrorWatcher(provider));

  const openSidebarCommand = vscode.commands.registerCommand(
    'bansou.openSidebar',
    async () => {
      await vscode.commands.executeCommand(
        'workbench.view.extension.bansou'
      );
    }
  );

  context.subscriptions.push(openSidebarCommand);

  const openDocsCommand = vscode.commands.registerCommand(
    'bansou.openOfficialDocs',
    async (options?: Parameters<typeof openOfficialDocs>[0]) => {
      await openOfficialDocs(options);
    }
  );

  context.subscriptions.push(openDocsCommand);

  const docsWebviewProvider = new DocsWebviewViewProvider(
    context,
    context.extensionUri
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DocsWebviewViewProvider.viewId,
      docsWebviewProvider
    )
  );

  output.appendLine('BANSOU docs: recommendations webview registered');
  output.appendLine(
    `BANSOU docs config: ${JSON.stringify(
      vscode.workspace.getConfiguration('bansou.docs'),
      null,
      2
    )}`
  );
}

export function deactivate() {}

function loadDotEnv(): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const envPath = path.join(folder.uri.fsPath, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function registerTerminalErrorWatcher(
  provider: QuizViewProvider
): vscode.Disposable {
  const terminalDataApi = vscode.window as unknown as {
    onDidWriteTerminalData?: (
      listener: (event: { terminal: vscode.Terminal; data: string }) => void
    ) => vscode.Disposable;
  };
  if (!terminalDataApi.onDidWriteTerminalData) {
    return new vscode.Disposable(() => {});
  }
  const buffers = new Map<string, string>();
  let lastError = '';
  let lastErrorAt = 0;

  return terminalDataApi.onDidWriteTerminalData((event) => {
    const config = vscode.workspace.getConfiguration('understandingQuiz');
    if (!config.get<boolean>('terminalErrorQuiz', true)) {
      return;
    }
    const key = event.terminal.name;
    const previous = buffers.get(key) ?? '';
    const combined = previous + event.data;
    const lines = combined.split(/\r?\n/);
    buffers.set(key, lines.pop() ?? '');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!looksLikeError(trimmed)) continue;
      const now = Date.now();
      if (trimmed === lastError && now - lastErrorAt < 5000) {
        continue;
      }
      lastError = trimmed;
      lastErrorAt = now;
      void promptErrorQuiz(trimmed, provider);
      break;
    }
  });
}

function looksLikeError(line: string): boolean {
  return (
    /error/i.test(line) ||
    /exception/i.test(line) ||
    /failed/i.test(line) ||
    /traceback/i.test(line) ||
    /\bTS\d+\b/.test(line)
  );
}

async function promptErrorQuiz(
  errorLine: string,
  provider: QuizViewProvider
): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    'ターミナルエラーを検知しました。原因理解クイズを作成しますか？',
    'クイズを作成'
  );
  if (action === 'クイズを作成') {
    await provider.generateErrorQuizFromLine(errorLine);
    await vscode.commands.executeCommand(
      'workbench.view.extension.bansou'
    );
  }
}
