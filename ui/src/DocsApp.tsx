import React, { useEffect, useMemo, useState } from 'react';

type RecommendationItem = {
  id: string;
  label: string;
  description?: string;
  iconId: string;
  action: {
    query?: string;
    languageId?: string;
    openLocation?: 'internal' | 'external';
    kind?: 'symbol' | 'package' | 'language' | 'search' | 'url';
  };
};

type RecommendationGroup = {
  key: string;
  title: string;
  iconId: string;
  items: RecommendationItem[];
};

type RecommendationsPayload = {
  groups: RecommendationGroup[];
};

type RecommendationsContext = {
  filePath: string;
  languageId: string;
  query: string;
};

type ExtensionMessage =
  | { type: 'recommendations'; payload: RecommendationsPayload; context: RecommendationsContext }
  | { type: 'empty'; message: string };

const vscode = acquireVsCodeApi();

export default function DocsApp() {
  const [groups, setGroups] = useState<RecommendationGroup[]>([]);
  const [context, setContext] = useState<RecommendationsContext | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      if (message.type === 'recommendations') {
        setGroups(message.payload.groups);
        setContext(message.context);
        setEmptyMessage(null);
        return;
      }
      if (message.type === 'empty') {
        setGroups([]);
        setContext(null);
        setEmptyMessage(message.message);
      }
    };

    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getRecommendations' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const totalItems = useMemo(
    () => groups.reduce((sum, group) => sum + group.items.length, 0),
    [groups]
  );

  const handleOpen = (item: RecommendationItem) => {
    vscode.postMessage({ type: 'openDoc', action: item.action });
  };

  return (
    <div className="docs-app">
      <header className="docs-hero">
        <div>
          <p className="eyebrow">BANSOU Docs</p>
          <h1>Recommended References</h1>
          <p className="sub">
            {context
              ? `${context.languageId} / ${context.filePath.split('/').pop() ?? ''}`
              : 'Open a file to see recommendations.'}
          </p>
        </div>
        <div className="docs-meta">
          <div className="docs-pill">Items: {totalItems}</div>
          <button
            type="button"
            className="ghost"
            onClick={() => vscode.postMessage({ type: 'getRecommendations' })}
          >
            Refresh
          </button>
        </div>
      </header>

      {emptyMessage ? (
        <section className="panel docs-empty">
          <p className="muted">{emptyMessage}</p>
        </section>
      ) : (
        <section className="docs-grid">
          {groups.map((group) => (
            <div key={group.key} className="panel docs-group">
              <div className="docs-group__header">
                <div className="docs-group__title">
                  <span className={`docs-icon docs-icon--${group.iconId}`} />
                  <h2>{group.title}</h2>
                </div>
                <span className="tag">{group.items.length}</span>
              </div>
              <div className="docs-list">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="docs-item"
                    onClick={() => handleOpen(item)}
                  >
                    <div className="docs-item__title">{item.label}</div>
                    {item.description && (
                      <div className="docs-item__desc">{item.description}</div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
