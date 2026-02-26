import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import { QuizViewProvider } from './features/quiz/QuizViewProvider';
import { openOfficialDocs } from './features/docs/openOfficialDocs';
import { DocsWebviewViewProvider } from './features/docs/DocsWebviewViewProvider';

let isActivated = false;

export function activate(context: vscode.ExtensionContext) {
  if (isActivated) {
    return;
  }
  isActivated = true;

  const output = vscode.window.createOutputChannel('BANSOU');
  output.appendLine('BANSOU activate');
  loadDotEnv();
  const provider = new QuizViewProvider(context, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QuizViewProvider.viewId, provider)
  );

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

export function deactivate() {
  isActivated = false;
}

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
