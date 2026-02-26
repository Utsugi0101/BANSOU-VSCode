import * as vscode from 'vscode';
import type { DocsOpenOptions } from './openOfficialDocs';

type DocsConfig = {
  languageSearchUrls: Record<string, string>;
  symbolSearchUrls: Record<string, string>;
  fallbackSearchUrl: string;
  packageSearchUrls: Record<string, string>;
  packageFallbackSearchUrl: string;
  maxRecommendations: number;
  patternRules: Array<{
    id: string;
    label: string;
    kind: 'react' | 'typescript' | 'general';
    pattern: string;
    url: string;
    languageIds?: string[];
  }>;
  debug: boolean;
  debugVerbose: boolean;
};

type RecommendationGroup =
  | 'patterns'
  | 'symbols'
  | 'packages'
  | 'language'
  | 'search';

export class DocsRecommendationProvider
  implements vscode.TreeDataProvider<DocItem>
{
  private readonly output = vscode.window.createOutputChannel('BANSOU Docs');
  private readonly onDidChangeTreeDataEmitter =
    new vscode.EventEmitter<DocItem | void>();
  readonly onDidChangeTreeData =
    this.onDidChangeTreeDataEmitter.event;
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastLogKey = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('bansou.docs')) {
          this.scheduleRefresh();
        }
      })
    );
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 5000);
  }

  getTreeItem(element: DocItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DocItem): Promise<DocItem[]> {
    if (element instanceof CategoryItem) {
      return element.children;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logDebug('No active editor. Showing info item.');
      return [
        new DocItem('ファイルを開くとおすすめが表示されます', {
          iconPath: new vscode.ThemeIcon('info'),
        }),
      ];
    }

    const document = editor.document;
    const languageId = document.languageId;
    const config = getDocsConfig();
    const query = getQueryFromEditor(editor);
    const groups = new Map<RecommendationGroup, DocItem[]>();
    const addItem = (group: RecommendationGroup, item: DocItem) => {
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    };

    const text = document.getText();
    const packageNames = extractPackageNames(text).slice(
      0,
      config.maxRecommendations
    );
    const symbolHits = extractSymbolHits(text, config.symbolSearchUrls).slice(
      0,
      config.maxRecommendations
    );
    const patternHits = extractPatternHits(
      text,
      config.patternRules,
      languageId
    ).slice(0, config.maxRecommendations);

    this.logDebug(
      `doc=${document.uri.fsPath} length=${text.length} hasUseEffect=${/\buseEffect\b/.test(
        text
      )} hasUseState=${/\buseState\b/.test(text)} hasUseMemo=${/\buseMemo\b/.test(
        text
      )} hasJSX=${/<[A-Z][A-Za-z0-9]*/.test(text)}`
    );
    this.logVerbose(getRuleDiagnostics(config, text, languageId));
    this.logVerbose(
      `preview=${JSON.stringify(text.slice(0, 200))} packages=${JSON.stringify(
        packageNames
      )} symbols=${JSON.stringify(symbolHits)} patterns=${JSON.stringify(
        patternHits.map((hit) => hit.label)
      )}`
    );

    this.logDebug(
      `languageId=${languageId} query=${query || '-'} packages=${packageNames.length} symbols=${symbolHits.length} patterns=${patternHits.length} rules=${config.patternRules.length}`
    );

    if (packageNames.length > 0) {
      for (const pkg of packageNames) {
        addItem(
          'packages',
          new DocItem(`パッケージ: ${pkg}`, {
            description: 'パッケージ情報を開く',
            iconPath: new vscode.ThemeIcon('package'),
            command: buildCommand({
              query: pkg,
              languageId,
              kind: 'package',
            }),
          })
        );
      }
    }

    if (symbolHits.length > 0) {
      for (const symbol of symbolHits) {
        addItem(
          'symbols',
          new DocItem(`シンボル: ${symbol}`, {
            description: '公式ドキュメントを開く',
            iconPath: new vscode.ThemeIcon('symbol-key'),
            command: buildCommand({
              query: symbol,
              languageId,
              kind: 'symbol',
            }),
          })
        );
      }
    }

    if (patternHits.length > 0) {
      for (const hit of patternHits) {
        addItem(
          'patterns',
          new DocItem(hit.label, {
            description: hit.description,
            iconPath: new vscode.ThemeIcon('sparkle'),
            command: buildCommand({
              query: hit.query,
              languageId,
              kind: 'url',
            }),
          })
        );
      }
    }

    if (query) {
      addItem(
        'search',
        new DocItem(`検索: ${query}`, {
          description: `${languageId} 公式ドキュメント`,
          iconPath: new vscode.ThemeIcon('search'),
          command: buildCommand({ query, languageId, kind: 'search' }),
        })
      );
    }

    const languageTemplate =
      config.languageSearchUrls[languageId] ?? config.fallbackSearchUrl;
    if (languageTemplate) {
      addItem(
        'language',
        new DocItem(`言語: ${languageId}`, {
          description: '公式ドキュメントを開く',
          iconPath: new vscode.ThemeIcon('book'),
          command: buildCommand({
            query: languageId,
            languageId,
            kind: 'language',
          }),
        })
      );
    }

    const categories = buildCategories(groups);
    if (categories.length === 0) {
      this.logDebug('No recommendations found. Showing warning item.');
      return [
        new DocItem('おすすめが見つかりませんでした', {
          iconPath: new vscode.ThemeIcon('warning'),
        }),
      ];
    }

    this.logDebug(
      `groups=${Array.from(groups.entries())
        .map(([key, list]) => `${key}:${list.length}`)
        .join(' ')}`
    );

    return categories;
  }

  private logDebug(message: string): void {
    const config = vscode.workspace.getConfiguration('bansou.docs');
    if (!config.get<boolean>('debug', false)) return;
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    const key = doc
      ? `${doc.uri.fsPath}:${doc.version}:${message.split(' ')[0] ?? ''}`
      : `no-editor:${message}`;
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    this.output.appendLine(message);
  }

  private logVerbose(message: string): void {
    const config = vscode.workspace.getConfiguration('bansou.docs');
    if (!config.get<boolean>('debugVerbose', false)) return;
    this.output.appendLine(message);
  }
}

class DocItem extends vscode.TreeItem {
  constructor(
    label: string,
    options: {
      description?: string;
      iconPath?: vscode.ThemeIcon;
      command?: vscode.Command;
    }
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = options.description;
    this.iconPath = options.iconPath;
    this.command = options.command;
    this.contextValue = 'bansou.docItem';
  }
}

class CategoryItem extends DocItem {
  constructor(
    label: string,
    readonly children: DocItem[],
    iconId: string
  ) {
    super(label, {
      iconPath: new vscode.ThemeIcon(iconId),
    });
    this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  }
}

function getQueryFromEditor(editor: vscode.TextEditor): string {
  const document = editor.document;
  const selection = editor.selection;
  let query = selection.isEmpty
    ? ''
    : document.getText(selection).trim();
  if (!query) {
    const wordRange = document.getWordRangeAtPosition(selection.active);
    if (wordRange) {
      query = document.getText(wordRange).trim();
    }
  }
  return query;
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
  const packageSearchUrls = config.get<Record<string, string>>(
    'packageSearchUrls',
    {}
  );
  const packageFallbackSearchUrl = config.get<string>(
    'packageFallbackSearchUrl',
    ''
  );
  const maxRecommendations = config.get<number>('maxRecommendations', 12);
  const patternRules = config.get<
    Array<{
      id: string;
      label: string;
      kind: 'react' | 'typescript' | 'general';
      pattern: string;
      url: string;
      languageIds?: string[];
    }>
  >('patternRules', []);
  const debug = config.get<boolean>('debug', false);
  const debugVerbose = config.get<boolean>('debugVerbose', false);
  return {
    languageSearchUrls,
    symbolSearchUrls,
    fallbackSearchUrl,
    packageSearchUrls,
    packageFallbackSearchUrl,
    maxRecommendations,
    patternRules,
    debug,
    debugVerbose,
  };
}

function buildCategories(
  groups: Map<RecommendationGroup, DocItem[]>
): CategoryItem[] {
  const order: Array<{
    key: RecommendationGroup;
    label: string;
    icon: string;
  }> = [
    { key: 'patterns', label: 'Patterns', icon: 'sparkle' },
    { key: 'symbols', label: 'Symbols', icon: 'symbol-key' },
    { key: 'packages', label: 'Packages', icon: 'package' },
    { key: 'search', label: 'Search', icon: 'search' },
    { key: 'language', label: 'Language', icon: 'book' },
  ];
  const categories: CategoryItem[] = [];
  for (const { key, label, icon } of order) {
    const items = groups.get(key);
    if (items && items.length > 0) {
      categories.push(new CategoryItem(label, items, icon));
    }
  }
  return categories;
}

function buildCommand(options: DocsOpenOptions): vscode.Command {
  return {
    command: 'bansou.openOfficialDocs',
    title: 'Open Official Docs',
    arguments: [options],
  };
}

function extractPackageNames(text: string): string[] {
  const results = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?/g,
    /\bfrom\s+([A-Za-z_][A-Za-z0-9_\.]*)\s+import\s+/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      let value = match[1]?.trim();
      if (!value || value.startsWith('.') || value.startsWith('/')) {
        continue;
      }
      if (value.includes('.')) {
        value = value.split('.')[0] ?? value;
      }
      results.add(value);
    }
  }
  return Array.from(results);
}

function extractSymbolHits(
  text: string,
  symbolSearchUrls: Record<string, string>
): string[] {
  const results: string[] = [];
  for (const symbol of Object.keys(symbolSearchUrls)) {
    if (!symbol) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g');
    if (pattern.test(text)) {
      results.push(symbol);
    }
  }
  return results;
}

function extractPatternHits(
  text: string,
  rules: DocsConfig['patternRules'],
  languageId: string
): Array<{ label: string; description: string; query: string }> {
  const results: Array<{ label: string; description: string; query: string }> =
    [];
  for (const rule of rules) {
    if (
      Array.isArray(rule.languageIds) &&
      rule.languageIds.length > 0 &&
      !rule.languageIds.includes(languageId)
    ) {
      continue;
    }
    let regex: RegExp;
    const normalized = normalizePattern(rule.pattern);
    try {
      regex = new RegExp(normalized, 'm');
    } catch {
      continue;
    }
    if (!regex.test(text)) {
      continue;
    }
    const label = `${rule.kind.toUpperCase()}: ${rule.label}`;
    results.push({
      label,
      description: '書き方/機能の公式ドキュメント',
      query: rule.url,
    });
  }
  return results;
}

function getRuleDiagnostics(
  config: DocsConfig,
  text: string,
  languageId: string
): string {
  if (!config.debugVerbose) return '';
  const hooksRule = config.patternRules.find((rule) => rule.id === 'react-hooks');
  const jsxRule = config.patternRules.find((rule) => rule.id === 'react-jsx');
  const checks: Array<{ id: string; result: string }> = [];

  if (hooksRule) {
    const applicable =
      !hooksRule.languageIds ||
      hooksRule.languageIds.length === 0 ||
      hooksRule.languageIds.includes(languageId);
    let match = false;
    const normalized = normalizePattern(hooksRule.pattern);
    if (applicable) {
      try {
        match = new RegExp(normalized, 'm').test(text);
      } catch {
        match = false;
      }
    }
    checks.push({
      id: hooksRule.id,
      result: `applicable=${applicable} pattern=${JSON.stringify(
        normalized
      )} match=${match}`,
    });
  }

  if (jsxRule) {
    const applicable =
      !jsxRule.languageIds ||
      jsxRule.languageIds.length === 0 ||
      jsxRule.languageIds.includes(languageId);
    let match = false;
    const normalized = normalizePattern(jsxRule.pattern);
    if (applicable) {
      try {
        match = new RegExp(normalized, 'm').test(text);
      } catch {
        match = false;
      }
    }
    checks.push({
      id: jsxRule.id,
      result: `applicable=${applicable} pattern=${JSON.stringify(
        normalized
      )} match=${match}`,
    });
  }

  if (checks.length === 0) return '';
  return `ruleDiagnostics=${checks.map((c) => `${c.id}:{${c.result}}`).join(' ')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\\\/g, '\\');
}
