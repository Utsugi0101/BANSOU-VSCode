import * as vscode from 'vscode';
import { QuizSession } from '../types';

const SESSIONS_KEY = 'bansou.sessions';

export function loadSessions(
  context: vscode.ExtensionContext
): QuizSession[] {
  return context.workspaceState.get<QuizSession[]>(SESSIONS_KEY, []);
}

export async function saveSession(
  context: vscode.ExtensionContext,
  session: QuizSession
): Promise<void> {
  const sessions = loadSessions(context);
  sessions.unshift(session);
  await context.workspaceState.update(SESSIONS_KEY, sessions);
}
