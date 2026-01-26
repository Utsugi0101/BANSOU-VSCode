import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  buildRecommendations,
  getDocsConfig,
  type RecommendationsPayload,
} from './recommendations';
import { openOfficialDocs, type DocsOpenOptions } from './openOfficialDocs';

type WebviewMessage =
  | { type: 'getRecommendations' }
  | { type: 'openDoc'; action: DocsOpenOptions };

type RecommendationsContext = {
  filePath: string;
  languageId: string;
  query: string;
};

export class DocsWebviewViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'bansou.docs.recommendations';

  private view?: vscode.WebviewView;
  private readonly output = vscode.window.createOutputChannel('BANSOU Docs');

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri
  ) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('bansou.docs')) {
          this.refresh();
        }
      })
    );
  }

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
    this.refresh();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'getRecommendations':
        this.postRecommendations();
        return;
      case 'openDoc':
        await openOfficialDocs(message.action);
        return;
      default:
        return;
    }
  }

  private refresh(): void {
    if (!this.view) return;
    this.postRecommendations();
  }

  private postRecommendations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.view?.webview.postMessage({
        type: 'empty',
        message: 'ファイルを開くとおすすめが表示されます。',
      });
      return;
    }

    const document = editor.document;
    const text = document.getText();
    const languageId = document.languageId;
    const query = getQueryFromEditor(editor);
    const config = getDocsConfig();

    const payload = buildRecommendations(text, languageId, query, config);
    const context: RecommendationsContext = {
      filePath: document.uri.fsPath,
      languageId,
      query,
    };

    if (config.debug) {
      this.output.appendLine(
        `webview: languageId=${languageId} query=${query || '-'} groups=${payload.groups.length}`
      );
    }

    if (config.debugVerbose) {
      this.output.appendLine(
        `webview: doc=${document.uri.fsPath} length=${text.length}`
      );
    }

    this.view?.webview.postMessage({
      type: 'recommendations',
      payload,
      context,
    });
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
    const entry = manifest['src/docs-main.tsx'] ?? manifest['docs'];
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
    <title>BANSOU Docs</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getQueryFromEditor(editor: vscode.TextEditor): string {
  const document = editor.document;
  const selection = editor.selection;
  let query = selection.isEmpty ? '' : document.getText(selection).trim();
  if (!query) {
    const wordRange = document.getWordRangeAtPosition(selection.active);
    if (wordRange) {
      query = document.getText(wordRange).trim();
    }
  }
  return query;
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
