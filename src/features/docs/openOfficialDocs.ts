import * as vscode from 'vscode';

type DocsConfig = {
  languageSearchUrls: Record<string, string>;
  symbolSearchUrls: Record<string, string>;
  fallbackSearchUrl: string;
  openLocation: 'internal' | 'external';
  packageSearchUrls: Record<string, string>;
  packageFallbackSearchUrl: string;
};

export type DocsOpenOptions = {
  query?: string;
  languageId?: string;
  openLocation?: 'internal' | 'external';
  kind?: 'symbol' | 'package' | 'language' | 'search' | 'url';
};

let docsPanel: vscode.WebviewPanel | undefined;

export async function openOfficialDocs(
  options: DocsOpenOptions = {}
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  const languageId = options.languageId ?? document?.languageId ?? '';
  let query = options.query ?? '';

  if (!query && editor && document) {
    const selection = editor.selection;
    query = selection.isEmpty
      ? ''
      : document.getText(selection).trim();
    if (!query) {
      const wordRange = document.getWordRangeAtPosition(selection.active);
      if (wordRange) {
        query = document.getText(wordRange).trim();
      }
    }
  }

  if (!query) {
    if (languageId) {
      query = languageId;
    } else {
      void vscode.window.showInformationMessage(
        'ドキュメントにジャンプする対象が見つかりません。選択するかカーソルを合わせてください。'
      );
      return;
    }
  }

  const config = getDocsConfig();
  if (options.kind === 'url' || looksLikeUrl(query)) {
    const url = query;
    const openLocation = options.openLocation ?? config.openLocation;
    if (openLocation === 'internal') {
      openDocsInWebview(url, query);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  const template = resolveTemplate(config, query, languageId, options.kind);

  if (!template) {
    void vscode.window.showInformationMessage(
      'ドキュメントURLが設定されていません。設定からbansou.docsを追加してください。'
    );
    return;
  }

  const url = buildDocUrl(template, query, languageId);
  const openLocation = options.openLocation ?? config.openLocation;
  if (openLocation === 'internal') {
    openDocsInWebview(url, query);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function buildDocUrl(
  template: string,
  query: string,
  languageId: string
): string {
  const encoded = encodeURIComponent(query);
  return template
    .replace(/\{query\}/g, encoded)
    .replace(/\{symbol\}/g, encoded)
    .replace(/\{languageId\}/g, encodeURIComponent(languageId));
}

function getDocsConfig(): DocsConfig {
  const config = vscode.workspace.getConfiguration('bansou.docs');
  const languageSearchUrls = config.get<Record<string, string>>(
    'languageSearchUrls',
    {}
  );
  const symbolSearchUrls = config.get<Record<string, string>>(
    'symbolSearchUrls',
    {}
  );
  const fallbackSearchUrl = config.get<string>(
    'fallbackSearchUrl',
    ''
  );
  const openLocation = config.get<'internal' | 'external'>(
    'openLocation',
    'external'
  );
  const packageSearchUrls = config.get<Record<string, string>>(
    'packageSearchUrls',
    {}
  );
  const packageFallbackSearchUrl = config.get<string>(
    'packageFallbackSearchUrl',
    ''
  );
  return {
    languageSearchUrls,
    symbolSearchUrls,
    fallbackSearchUrl,
    openLocation,
    packageSearchUrls,
    packageFallbackSearchUrl,
  };
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveTemplate(
  config: DocsConfig,
  query: string,
  languageId: string,
  kind?: DocsOpenOptions['kind']
): string {
  if (kind === 'package') {
    return (
      config.packageSearchUrls[query] || config.packageFallbackSearchUrl
    );
  }
  if (kind === 'language') {
    return config.languageSearchUrls[languageId] || config.fallbackSearchUrl;
  }
  if (kind === 'symbol') {
    return (
      config.symbolSearchUrls[query] ||
      config.languageSearchUrls[languageId] ||
      config.fallbackSearchUrl
    );
  }
  return (
    config.symbolSearchUrls[query] ||
    config.languageSearchUrls[languageId] ||
    config.fallbackSearchUrl
  );
}

function openDocsInWebview(url: string, query: string): void {
  if (!docsPanel) {
    docsPanel = vscode.window.createWebviewPanel(
      'bansou.docs',
      'BANSOU Docs',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    docsPanel.onDidDispose(() => {
      docsPanel = undefined;
    });
    docsPanel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'openExternal' && typeof message?.url === 'string') {
        void vscode.env.openExternal(vscode.Uri.parse(message.url));
      }
    });
  } else {
    docsPanel.reveal(vscode.ViewColumn.Beside);
  }

  docsPanel.title = `BANSOU Docs: ${query || 'Search'}`;
  docsPanel.webview.html = getDocsWebviewHtml(docsPanel.webview, url, query);
}

function getDocsWebviewHtml(
  webview: vscode.Webview,
  url: string,
  query: string
): string {
  const nonce = getNonce();
  const escapedUrl = escapeHtml(url);
  const escapedQuery = escapeHtml(query);
  const csp = [
    "default-src 'none'",
    `frame-src https: http:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} https: http: data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>BANSOU Docs</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #4445; }
      button { padding: 6px 10px; border-radius: 6px; border: 1px solid #6665; background: #2d2d2d; color: inherit; cursor: pointer; }
      button:hover { filter: brightness(1.1); }
      .note { font-size: 12px; opacity: 0.7; }
      iframe { width: 100vw; height: calc(100vh - 48px); border: none; }
    </style>
  </head>
  <body>
    <header>
      <strong>Docs</strong>
      <span class="note">Query: ${escapedQuery || '-'}</span>
      <span style="flex:1"></span>
      <button id="openExternal">外部ブラウザで開く</button>
    </header>
    <iframe src="${escapedUrl}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('openExternal').addEventListener('click', () => {
        vscode.postMessage({ type: 'openExternal', url: ${JSON.stringify(url)} });
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
