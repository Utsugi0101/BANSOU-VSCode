import React, { useEffect, useMemo, useState } from 'react';

type DiffFile = {
  path: string;
  isExcludedByDefault: boolean;
};

type QuizQuestion = {
  filePath: string;
  question: string;
  options: [string, string, string, string];
  answerIndex: number;
  rationale?: string;
};

type QuizSet = {
  title: string;
  questions: QuizQuestion[];
};

type GradeResult = {
  score: number;
  passed: boolean;
  token: string;
  prTemplate: string;
  attestationPath: string;
  correct: number;
  total: number;
};

type ExtensionMessage =
  | {
      type: 'diffFiles';
      diffFiles: DiffFile[];
      repo: string;
      openAIMode: 'localOnly' | 'useOpenAI';
    }
  | { type: 'quizSet'; quizSet: QuizSet }
  | {
      type: 'gradeResult';
      score: number;
      passed: boolean;
      token: string;
      prTemplate: string;
      attestationPath: string;
      correct: number;
      total: number;
    }
  | { type: 'summaryResult'; summaryLines: string[]; prDraft: string }
  | { type: 'errorQuizSet'; quizSet: QuizSet; errorLine: string }
  | { type: 'error'; message: string };

const vscode = acquireVsCodeApi();

export default function App() {
  const [repoName, setRepoName] = useState<string>('workspace');
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, boolean>>({});
  const [openAIMode, setOpenAIMode] = useState<'localOnly' | 'useOpenAI'>('localOnly');
  const [quizSet, setQuizSet] = useState<QuizSet | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [summaryLines, setSummaryLines] = useState<string[] | null>(null);
  const [prDraft, setPrDraft] = useState<string | null>(null);
  const [errorQuizSet, setErrorQuizSet] = useState<QuizSet | null>(null);
  const [errorQuizLine, setErrorQuizLine] = useState<string | null>(null);
  const [errorQuizAnswers, setErrorQuizAnswers] = useState<number[]>([]);
  const [errorQuizResult, setErrorQuizResult] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'diffFiles': {
          setRepoName(message.repo);
          setDiffFiles(message.diffFiles);
          setOpenAIMode(message.openAIMode);
          const initialSelection: Record<string, boolean> = {};
          message.diffFiles.forEach((file) => {
            initialSelection[file.path] = !file.isExcludedByDefault;
          });
          setSelectedFiles(initialSelection);
          setStatusMessage(null);
          return;
        }
        case 'quizSet': {
          setQuizSet(message.quizSet);
          setAnswers(new Array(message.quizSet.questions.length).fill(-1));
          setCurrentIndex(0);
          setResult(null);
          setIsGenerating(false);
          setStatusMessage(null);
          return;
        }
        case 'gradeResult': {
          setResult({
            score: message.score,
            passed: message.passed,
            token: message.token,
            prTemplate: message.prTemplate,
            attestationPath: message.attestationPath,
            correct: message.correct,
            total: message.total,
          });
          setStatusMessage(null);
          return;
        }
        case 'summaryResult': {
          setSummaryLines(message.summaryLines);
          setPrDraft(message.prDraft);
          setIsSummarizing(false);
          setStatusMessage(null);
          return;
        }
        case 'errorQuizSet': {
          setErrorQuizSet(message.quizSet);
          setErrorQuizLine(message.errorLine);
          setErrorQuizAnswers(new Array(message.quizSet.questions.length).fill(-1));
          setErrorQuizResult(null);
          setStatusMessage(null);
          return;
        }
        case 'error': {
          setStatusMessage(message.message);
          setIsGenerating(false);
          setIsSummarizing(false);
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getDiffFiles' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const selectedList = useMemo(
    () => diffFiles.filter((file) => selectedFiles[file.path]).map((file) => file.path),
    [diffFiles, selectedFiles]
  );

  const currentQuestion = quizSet?.questions[currentIndex];

  const handleFetchDiff = () => {
    setStatusMessage(null);
    vscode.postMessage({ type: 'getDiffFiles' });
  };

  const handleGenerateQuiz = () => {
    if (!selectedList.length) {
      setStatusMessage('クイズ生成の対象ファイルを選択してください。');
      return;
    }
    setIsGenerating(true);
    setStatusMessage('クイズを生成しています...');
    vscode.postMessage({ type: 'generateQuiz', files: selectedList });
  };

  const handleGenerateSummary = () => {
    if (!selectedList.length) {
      setStatusMessage('要約の対象ファイルを選択してください。');
      return;
    }
    setIsSummarizing(true);
    setStatusMessage('要約を生成しています...');
    vscode.postMessage({ type: 'generateSummary', files: selectedList });
  };

  const handleSelectOption = (optionIndex: number) => {
    if (!quizSet) return;
    const updated = [...answers];
    updated[currentIndex] = optionIndex;
    setAnswers(updated);
  };

  const handleNext = () => {
    if (!quizSet) return;
    setCurrentIndex((prev) => Math.min(prev + 1, quizSet.questions.length - 1));
  };

  const handlePrev = () => {
    if (!quizSet) return;
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleSubmit = () => {
    if (!quizSet) return;
    if (answers.some((answer) => answer < 0)) {
      setStatusMessage('すべての問題に回答してから提出してください。');
      return;
    }
    vscode.postMessage({ type: 'submitAnswers', answers });
  };

  const handleCopyToken = async () => {
    if (!result?.token) return;
    await navigator.clipboard.writeText(result.token);
    setStatusMessage('トークンをクリップボードにコピーしました。');
  };

  const handleCopyAttestationPath = async () => {
    if (!result?.attestationPath) return;
    await navigator.clipboard.writeText(result.attestationPath);
    setStatusMessage('attestation のパスをコピーしました。');
  };

  const handleCopyPrTemplate = async () => {
    if (!result?.prTemplate) return;
    await navigator.clipboard.writeText(result.prTemplate);
    setStatusMessage('PRテンプレートをコピーしました。');
  };

  const handleCopyPrDraft = async () => {
    if (!prDraft) return;
    await navigator.clipboard.writeText(prDraft);
    setStatusMessage('PR下書きをコピーしました。');
  };

  const handleSelectErrorOption = (index: number, option: number) => {
    const updated = [...errorQuizAnswers];
    updated[index] = option;
    setErrorQuizAnswers(updated);
  };

  const handleSubmitErrorQuiz = () => {
    if (!errorQuizSet) return;
    const unanswered = errorQuizAnswers.some((answer) => answer < 0);
    if (unanswered) {
      setStatusMessage('エラー原因クイズの回答を選択してください。');
      return;
    }
    const results = errorQuizSet.questions.map((question, index) => {
      const selected = errorQuizAnswers[index];
      return selected === question.answerIndex ? '正解' : '不正解';
    });
    setErrorQuizResult(results.join(' / '));
  };

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">BANSOU</p>
          <h1>理解してから push しよう</h1>
          <p className="sub">
            git diff から理解確認クイズを作成し、合格トークンを発行します。
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary" onClick={handleFetchDiff}>
            git diff 取得
          </button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <h2>{repoName} の変更ファイル</h2>
          <span>{selectedList.length} 件選択</span>
        </div>
        <div className="file-list">
          {diffFiles.length === 0 && (
            <p className="muted">変更が見つかりません。差分を作って更新してください。</p>
          )}
          {diffFiles.map((file) => (
            <label key={file.path} className="file-row">
              <input
                type="checkbox"
                checked={Boolean(selectedFiles[file.path])}
                onChange={(event) =>
                  setSelectedFiles((prev) => ({
                    ...prev,
                    [file.path]: event.target.checked,
                  }))
                }
              />
              <span>{file.path}</span>
              {file.isExcludedByDefault && <span className="tag">初期は除外</span>}
            </label>
          ))}
        </div>
        <button className="secondary" onClick={handleGenerateQuiz} disabled={isGenerating}>
          {isGenerating ? '生成中...' : 'クイズ生成'}
        </button>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>変更要約 & PR下書き</h2>
          <span>mode: {openAIMode}</span>
        </div>
        <p className="muted">
          {openAIMode === 'localOnly'
            ? 'テンプレを生成します（OpenAIへ送信しません）。'
            : '選択した差分をOpenAIに送って要約と下書きを生成します。'}
        </p>
        <button className="secondary" onClick={handleGenerateSummary} disabled={isSummarizing}>
          {isSummarizing ? '生成中...' : '要約/PR下書きを生成'}
        </button>
        {summaryLines && (
          <div className="summary">
            <h3>変更要約</h3>
            <ul>
              {summaryLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        {prDraft && (
          <div className="token">
            <p className="meta">PR説明文（下書き）</p>
            <textarea readOnly value={prDraft} />
            <button className="secondary" onClick={handleCopyPrDraft}>
              PR下書きをコピー
            </button>
          </div>
        )}
      </section>

      {quizSet && (
        <section className="panel">
          <div className="panel-header">
            <h2>{quizSet.title}</h2>
            <span>
              第 {currentIndex + 1} 問 / {quizSet.questions.length}
            </span>
          </div>
          {currentQuestion && (
            <div className="question">
              <p className="meta">対象ファイル: {currentQuestion.filePath}</p>
              <h3>{currentQuestion.question}</h3>
              <div className="options">
                {currentQuestion.options.map((option, index) => (
                  <label
                    key={option}
                    className={`option ${answers[currentIndex] === index ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`question-${currentIndex}`}
                      value={index}
                      checked={answers[currentIndex] === index}
                      onChange={() => handleSelectOption(index)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="nav">
            <button className="ghost" onClick={handlePrev} disabled={currentIndex === 0}>
              前へ
            </button>
            <button
              className="ghost"
              onClick={handleNext}
              disabled={!quizSet || currentIndex === quizSet.questions.length - 1}
            >
              次へ
            </button>
            <button className="primary" onClick={handleSubmit}>
              提出
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="panel result">
          <div>
            <h2>結果</h2>
            <p className="score">
              {result.score}% ({result.correct}/{result.total})
            </p>
            <p className={result.passed ? 'pass' : 'fail'}>
              {result.passed ? '合格: トークンを発行しました' : '不合格: もう一度挑戦してください'}
            </p>
          </div>
          {result.token ? (
            <div className="token">
              <p className="meta">理解証明トークン (JWT)</p>
              <textarea readOnly value={result.token} />
              <button className="secondary" onClick={handleCopyToken}>
                トークンをコピー
              </button>
              <button className="ghost" onClick={handleCopyPrTemplate}>
                PRテンプレをコピー
              </button>
              <p className="meta">attestation file</p>
              <textarea readOnly value={result.attestationPath} />
              <button className="ghost" onClick={handleCopyAttestationPath}>
                パスをコピー
              </button>
            </div>
          ) : (
            <div className="token">
              <p className="meta">トークンは未発行</p>
              <p className="muted">
                合格スコアに達しない場合や設定不足の場合はトークンが発行されません。
              </p>
            </div>
          )}
        </section>
      )}

      {result && quizSet && (
        <section className="panel">
          <div className="panel-header">
            <h2>解説</h2>
            <span>{quizSet.questions.length} 問</span>
          </div>
          <div className="review">
            {quizSet.questions.map((question, index) => {
              const selected = answers[index];
              const isCorrect = selected === question.answerIndex;
              return (
                <div key={`${question.filePath}-${index}`} className="review-item">
                  <p className="meta">第 {index + 1} 問 / {question.filePath}</p>
                  <h3>{question.question}</h3>
                  <p className={isCorrect ? 'pass' : 'fail'}>
                    {isCorrect ? '正解' : '不正解'}（選択: {selected >= 0 ? question.options[selected] : '未回答'}）
                  </p>
                  <p className="meta">正解: {question.options[question.answerIndex]}</p>
                  <p className="rationale">{question.rationale || '（解説なし）'}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {errorQuizSet && (
        <section className="panel">
          <div className="panel-header">
            <h2>エラー原因クイズ</h2>
            <span>{errorQuizSet.questions.length} 問</span>
          </div>
          {errorQuizLine && <p className="meta">検知したエラー: {errorQuizLine}</p>}
          {errorQuizSet.questions.map((question, index) => (
            <div key={`error-${index}`} className="review-item">
              <h3>{question.question}</h3>
              <div className="options">
                {question.options.map((option, optionIndex) => (
                  <label
                    key={option}
                    className={`option ${errorQuizAnswers[index] === optionIndex ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`error-question-${index}`}
                      value={optionIndex}
                      checked={errorQuizAnswers[index] === optionIndex}
                      onChange={() => handleSelectErrorOption(index, optionIndex)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
              {errorQuizResult && (
                <p className="meta">
                  正解: {question.options[question.answerIndex]} / {question.rationale}
                </p>
              )}
            </div>
          ))}
          <div className="nav">
            <button className="primary" onClick={handleSubmitErrorQuiz}>
              回答を確認
            </button>
            {errorQuizResult && <span className="meta">{errorQuizResult}</span>}
          </div>
        </section>
      )}

      {statusMessage && <div className="status">{statusMessage}</div>}
    </div>
  );
}
