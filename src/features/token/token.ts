import { createHmac, createHash } from 'node:crypto';
import { QuizQuestion } from '../../types';

export type TokenPayload = {
  repo: string;
  commit: string;
  diffHash: string;
  issuedAt: string;
  score: number;
  questionSetHash: string;
  issuer: string;
};

export function computeQuestionSetHash(questions: QuizQuestion[]): string {
  const payload = JSON.stringify(questions);
  return createHash('sha256').update(payload).digest('base64url');
}

export function computeDiffHash(diffsByFile: Record<string, string>): string {
  const payload = Object.keys(diffsByFile)
    .sort()
    .map((key) => `${key}\n${diffsByFile[key]}`)
    .join('\n');
  return createHash('sha256').update(payload).digest('base64url');
}

export function issueToken(payload: TokenPayload): string {
  const secret = process.env.UNDERSTANDING_TOKEN_SECRET;
  if (!secret) {
    throw new Error(
      'UNDERSTANDING_TOKEN_SECRET is not set in the environment.'
    );
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}
