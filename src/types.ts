export type QuizQuestion = {
  filePath: string;
  question: string;
  options: [string, string, string, string];
  answerIndex?: number;
  rationale?: string;
  hunkSummary?: string;
};

export type QuizSet = {
  title: string;
  questions: QuizQuestion[];
};

export type QuizSession = {
  id: string;
  createdAt: string;
  repo: string;
  branch: string;
  commit: string;
  diffHash: string;
  issuer: string;
  files: string[];
  questions: QuizQuestion[];
  answers: number[];
  score: number;
  token: string;
  questionSetHash: string;
  answersHash?: string;
  summary?: string[];
  prDraft?: string;
  prTemplate?: string;
  attestationPath?: string;
};

export type DiffFile = {
  path: string;
  isExcludedByDefault: boolean;
};

export type QuizGenerationRequest = {
  files: string[];
  diffsByFile: Record<string, string>;
  desiredQuestionCount: number;
  title: string;
};

export type QuizGenerationResponse = QuizSet;

export type SummaryGenerationRequest = {
  files: string[];
  diffsByFile: Record<string, string>;
  title: string;
};

export type SummaryGenerationResponse = {
  summaryLines: string[];
  prDraft: string;
};
