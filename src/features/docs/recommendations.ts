import * as vscode from 'vscode';
import type { DocsOpenOptions } from './openOfficialDocs';

export type RecommendationGroup =
  | 'patterns'
  | 'symbols'
  | 'packages'
  | 'language'
  | 'search';

export type RecommendationItem = {
  id: string;
  label: string;
  description?: string;
  group: RecommendationGroup;
  iconId: string;
  action: DocsOpenOptions;
};

export type RecommendationGroupPayload = {
  key: RecommendationGroup;
  title: string;
  iconId: string;
  items: RecommendationItem[];
};

export type RecommendationsPayload = {
  groups: RecommendationGroupPayload[];
};

export type DocsConfig = {
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

export function getDocsConfig(): DocsConfig {
  const config = vscode.workspace.getConfiguration('bansou.docs');
  const languageSearchUrls = config.get<Record<string, string>>(
    'languageSearchUrls',
    {}
  );
  const symbolSearchUrls = config.get<Record<string, string>>(
    'symbolSearchUrls',
    {}
  );
  const fallbackSearchUrl = config.get<string>('fallbackSearchUrl', '');
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

export function buildRecommendations(
  text: string,
  languageId: string,
  query: string,
  config: DocsConfig
): RecommendationsPayload {
  const groups = new Map<RecommendationGroup, RecommendationItem[]>();
  const addItem = (group: RecommendationGroup, item: RecommendationItem) => {
    const list = groups.get(group) ?? [];
    list.push(item);
    groups.set(group, list);
  };

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

  for (const pkg of packageNames) {
    addItem('packages', {
      id: `package:${pkg}`,
      label: pkg,
      description: 'パッケージ情報を開く',
      group: 'packages',
      iconId: 'package',
      action: { query: pkg, languageId, kind: 'package' },
    });
  }

  for (const symbol of symbolHits) {
    addItem('symbols', {
      id: `symbol:${symbol}`,
      label: symbol,
      description: '公式ドキュメントを開く',
      group: 'symbols',
      iconId: 'symbol-key',
      action: { query: symbol, languageId, kind: 'symbol' },
    });
  }

  for (const hit of patternHits) {
    addItem('patterns', {
      id: `pattern:${hit.label}`,
      label: hit.label,
      description: hit.description,
      group: 'patterns',
      iconId: 'sparkle',
      action: { query: hit.query, languageId, kind: 'url' },
    });
  }

  if (query) {
    addItem('search', {
      id: `search:${query}`,
      label: `検索: ${query}`,
      description: `${languageId} 公式ドキュメント`,
      group: 'search',
      iconId: 'search',
      action: { query, languageId, kind: 'search' },
    });
  }

  const languageTemplate =
    config.languageSearchUrls[languageId] ?? config.fallbackSearchUrl;
  if (languageTemplate) {
    addItem('language', {
      id: `language:${languageId}`,
      label: `言語: ${languageId}`,
      description: '公式ドキュメントを開く',
      group: 'language',
      iconId: 'book',
      action: { query: languageId, languageId, kind: 'language' },
    });
  }

  return { groups: buildGroupsPayload(groups) };
}

export function normalizePattern(pattern: string): string {
  return pattern.replace(/\\\\/g, '\\');
}

export function extractPatternHits(
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

export function extractSymbolHits(
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

export function extractPackageNames(text: string): string[] {
  const results = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1]?.trim();
      if (!value || value.startsWith('.') || value.startsWith('/')) {
        continue;
      }
      results.add(value);
    }
  }
  return Array.from(results);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildGroupsPayload(
  groups: Map<RecommendationGroup, RecommendationItem[]>
): RecommendationGroupPayload[] {
  const order: Array<{
    key: RecommendationGroup;
    title: string;
    iconId: string;
  }> = [
    { key: 'patterns', title: 'Patterns', iconId: 'sparkle' },
    { key: 'symbols', title: 'Symbols', iconId: 'symbol-key' },
    { key: 'packages', title: 'Packages', iconId: 'package' },
    { key: 'search', title: 'Search', iconId: 'search' },
    { key: 'language', title: 'Language', iconId: 'book' },
  ];
  const result: RecommendationGroupPayload[] = [];
  for (const { key, title, iconId } of order) {
    const items = groups.get(key);
    if (items && items.length > 0) {
      result.push({ key, title, iconId, items });
    }
  }
  return result;
}
