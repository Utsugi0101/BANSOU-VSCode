export type QuizArtifact = {
  path: string;
  rangeStart?: number;
  rangeEnd?: number;
};

export type ServerQuizQuestion = {
  filePath: string;
  question: string;
  options: [string, string, string, string];
  rationale?: string;
  hunkSummary?: string;
};

export type QuizGenerateRequest = {
  sub: string;
  repo: string;
  commit: string;
  quiz_id: string;
  quiz_version: string;
  files: string[];
  diffsByFile: Record<string, string>;
  desiredQuestionCount?: number;
  artifacts?: QuizArtifact[];
};

export type QuizGenerateResponse = {
  quiz_id: string;
  quiz_version: string;
  questions_hash: string;
  diff_hash: string;
  quiz: {
    title: string;
    questions: ServerQuizQuestion[];
  };
  quiz_session_token: string;
  exp: number;
};

export type QuizSubmitRequest = {
  quiz_session_token: string;
  answers: number[];
  duration_ms?: number;
};

export type QuizSubmitResponse = {
  score: number;
  correct: number;
  total: number;
  passed: boolean;
  min_score: number;
  questions_hash: string;
  answers_hash: string;
  diff_hash: string;
  attestations: Array<{
    artifact: QuizArtifact;
    attestation_jwt: string;
    exp: number;
  }>;
};

async function fetchJson<T>(url: string, method: 'POST', body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server error (${response.status}): ${errorText || response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function generateServerQuiz(
  serverUrl: string,
  request: QuizGenerateRequest
): Promise<QuizGenerateResponse> {
  const url = new URL('/quiz/generate', serverUrl).toString();
  return fetchJson<QuizGenerateResponse>(url, 'POST', request);
}

export async function submitServerQuiz(
  serverUrl: string,
  request: QuizSubmitRequest
): Promise<QuizSubmitResponse> {
  const url = new URL('/quiz/submit', serverUrl).toString();
  return fetchJson<QuizSubmitResponse>(url, 'POST', request);
}
