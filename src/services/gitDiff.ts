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

async function getWorkingTreeFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only'], { cwd });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getHeadCommitFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['show', '--pretty=', '--name-only', 'HEAD'], {
    cwd,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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

  let files = await getWorkingTreeFiles(cwd);
  if (files.length === 0) {
    files = await getHeadCommitFiles(cwd);
  }

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
  if (stdout.trim().length > 0) {
    return stdout;
  }

  const { stdout: headDiff } = await execFileAsync('git', ['show', 'HEAD', '--', filePath], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return headDiff;
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
