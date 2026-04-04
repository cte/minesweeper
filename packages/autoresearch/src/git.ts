import { execFileSync } from "node:child_process";

export interface GitInfo {
  branch: string;
  commit: string;
  dirty: boolean;
}

export function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

export function currentBranch(projectRoot: string): string {
  return git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function currentCommit(projectRoot: string): string {
  return git(projectRoot, ["rev-parse", "--short", "HEAD"]);
}

export function branchExists(projectRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", branch], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function changedPaths(projectRoot: string): string[] {
  const status = execFileSync("git", ["status", "--short"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  if (status.length === 0) {
    return [];
  }
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
}

export function assertCleanWorktree(projectRoot: string): void {
  if (changedPaths(projectRoot).length > 0) {
    throw new Error("Worktree must be clean");
  }
}

export function restorePaths(projectRoot: string, editablePaths: string[]): void {
  execFileSync("git", ["restore", "--source", "HEAD", "--staged", "--worktree", "--", ...editablePaths], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

export function commitPaths(projectRoot: string, editablePaths: string[], message: string): string {
  execFileSync("git", ["add", "--", ...editablePaths], {
    cwd: projectRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-m", message], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return currentCommit(projectRoot);
}

export function getGitInfo(projectRoot: string): GitInfo {
  return {
    branch: currentBranch(projectRoot),
    commit: currentCommit(projectRoot),
    dirty: changedPaths(projectRoot).length > 0,
  };
}
