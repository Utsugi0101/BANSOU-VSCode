import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function execGitOptional(
  cwd: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

export type GitDiffInfo = {
  root: string;
  branch: string;
  commit: string;
  remoteUrl: string;
  userName: string;
  userEmail: string;
  files: string[];
};

export async function getGitMetadata(cwd: string): Promise<GitDiffInfo> {
  const [{ stdout: root }, { stdout: branch }, { stdout: commit }] =
    await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd }),
    ]);
  const [remoteUrl, userName, userEmail] = await Promise.all([
    execGitOptional(cwd, ['config', '--get', 'remote.origin.url']),
    execGitOptional(cwd, ['config', '--get', 'user.name']),
    execGitOptional(cwd, ['config', '--get', 'user.email']),
  ]);

  const { stdout: filesRaw } = await execFileAsync(
    'git',
    ['diff', '--name-only'],
    { cwd }
  );

  const files = filesRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    root: root.trim(),
    branch: branch.trim(),
    commit: commit.trim(),
    remoteUrl,
    userName,
    userEmail,
    files,
  };
}

export async function getDiffForFile(
  cwd: string,
  filePath: string
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['diff', '--', filePath], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export function countChangedLines(diffText: string): number {
  let count = 0;
  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      count += 1;
    }
  }
  return count;
}
