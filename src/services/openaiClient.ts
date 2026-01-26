import type OpenAIType from 'openai';
import {
  QuizGenerationRequest,
  QuizGenerationResponse,
  SummaryGenerationRequest,
  SummaryGenerationResponse,
} from '../types';

export interface OpenAIClient {
  generateQuiz(request: QuizGenerationRequest): Promise<QuizGenerationResponse>;
  generateSummary(
    request: SummaryGenerationRequest
  ): Promise<SummaryGenerationResponse>;
  generateErrorQuiz(errorLine: string): Promise<QuizGenerationResponse>;
}

const quizSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'questions'],
  properties: {
    title: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'filePath',
          'question',
          'options',
          'answerIndex',
          'rationale',
          'hunkSummary',
        ],
        properties: {
          filePath: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'string' },
          },
          answerIndex: { type: 'integer', minimum: 0, maximum: 3 },
          rationale: { type: 'string' },
          hunkSummary: { type: 'string' },
        },
      },
    },
  },
};

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summaryLines', 'prDraft'],
  properties: {
    summaryLines: {
      type: 'array',
      minItems: 3,
      maxItems: 7,
      items: { type: 'string' },
    },
    prDraft: { type: 'string' },
  },
};

export class OpenAIResponsesClient implements OpenAIClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateQuiz(
    request: QuizGenerationRequest
  ): Promise<QuizGenerationResponse> {
    const systemPrompt =
      'あなたは git diff に関する理解確認の選択式クイズを生成します。' +
      '提供されたJSONスキーマに完全一致するJSONのみを返してください。追加の文章は不要です。' +
      '出力は日本語で統一してください。';

    const userPrompt = [
      `Title: ${request.title}`,
      `DesiredQuestionCount: ${request.desiredQuestionCount}`,
      '指示:',
      '- 変更の意図/理由、変更後の動作（どう動くか）に集中する。',
      '- 誤答はありがちな誤解にする。',
      '- 各問題は入力された filePath のうち1つだけを参照する。',
      '- 各問題の選択肢は4つ。',
      '- hunkSummary は必ず含める（不要なら空文字でもよい）。',
      '- 問題文、選択肢、解説はすべて日本語。',
      '',
      'Diffs:',
      ...request.files.map((filePath) => {
        const diff = request.diffsByFile[filePath] ?? '';
        return [
          `FILE: ${filePath}`,
          'DIFF_START',
          diff,
          'DIFF_END',
          '',
        ].join('\n');
      }),
    ].join('\n');

    const { default: OpenAI } = (await import('openai')) as unknown as {
      default: typeof OpenAIType;
    };
    const client = new OpenAI({ apiKey: this.apiKey });

    const response = await client.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'quiz_schema',
          schema: quizSchema,
          strict: true,
        },
      },
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('OpenAI response was empty.');
    }
    return JSON.parse(outputText) as QuizGenerationResponse;
  }

  async generateSummary(
    request: SummaryGenerationRequest
  ): Promise<SummaryGenerationResponse> {
    const systemPrompt =
      'あなたは git diff の要約とPR説明文の下書きを生成します。' +
      '提供されたJSONスキーマに完全一致するJSONのみを返してください。';

    const userPrompt = [
      `Title: ${request.title}`,
      '指示:',
      '- 変更点の要約を3〜7行で出力する。',
      '- PR説明文はMarkdownで簡潔に書く。',
      '',
      'Diffs:',
      ...request.files.map((filePath) => {
        const diff = request.diffsByFile[filePath] ?? '';
        return [
          `FILE: ${filePath}`,
          'DIFF_START',
          diff,
          'DIFF_END',
          '',
        ].join('\n');
      }),
    ].join('\n');

    const { default: OpenAI } = (await import('openai')) as unknown as {
      default: typeof OpenAIType;
    };
    const client = new OpenAI({ apiKey: this.apiKey });

    const response = await client.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'summary_schema',
          schema: summarySchema,
          strict: true,
        },
      },
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('OpenAI response was empty.');
    }
    return JSON.parse(outputText) as SummaryGenerationResponse;
  }

  async generateErrorQuiz(errorLine: string): Promise<QuizGenerationResponse> {
    const systemPrompt =
      'あなたはエラー原因の理解を促す選択式クイズを生成します。' +
      '提供されたJSONスキーマに完全一致するJSONのみを返してください。';
    const userPrompt = [
      '指示:',
      '- エラーの原因理解を問う1問だけ作る。',
      '- 選択肢は4つ。',
      '- 正解はエラーの根本原因に最も近いもの。',
      '- filePath は "terminal" を使う。',
      '- hunkSummary は空文字でよい。',
      '',
      `ERROR_LINE: ${errorLine}`,
    ].join('\n');

    const { default: OpenAI } = (await import('openai')) as unknown as {
      default: typeof OpenAIType;
    };
    const client = new OpenAI({ apiKey: this.apiKey });

    const response = await client.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'quiz_schema',
          schema: quizSchema,
          strict: true,
        },
      },
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('OpenAI response was empty.');
    }
    return JSON.parse(outputText) as QuizGenerationResponse;
  }
}
