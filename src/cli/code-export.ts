import { execFile, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ResolvedCodeExportPaths = {
  outputDir: string;
  repoRoot: string;
};

export type TemporaryGitWorktree = {
  checkoutDir: string;
  commit: string;
};

/** Resolve and validate the source repository and destination directory. */
export async function resolveCodeExportPaths(
  repoInput: string,
  outputInput: string,
  force: boolean,
): Promise<ResolvedCodeExportPaths> {
  const requestedRepo = resolveUserPath(repoInput);
  let repoStat;
  try {
    repoStat = await stat(requestedRepo);
  } catch {
    throw new Error(`Repository directory does not exist: ${requestedRepo}`);
  }
  if (!repoStat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${requestedRepo}`);
  }

  let repoRoot: string;
  try {
    repoRoot = await realpath(
      await runGit(requestedRepo, ["rev-parse", "--show-toplevel"]),
    );
  } catch {
    throw new Error(`Not a Git repository: ${requestedRepo}`);
  }

  const requestedOutput = resolveUserPath(outputInput);
  await assertOutputCanBeReplaced(requestedOutput, force);
  const outputDir = await canonicalizePotentialPath(requestedOutput);
  if (isSamePathOrAncestor(outputDir, repoRoot)) {
    throw new Error(
      `Export output must not be the repository root or one of its ancestors: ${outputDir}`,
    );
  }

  return { outputDir, repoRoot };
}

/**
 * Check out a ref in a detached temporary worktree without changing the user's
 * active branch or including uncommitted working-tree changes.
 */
export async function withTemporaryGitWorktree<T>(
  repoRoot: string,
  gitRef: string,
  run: (worktree: TemporaryGitWorktree) => Promise<T>,
): Promise<T> {
  let commit: string;
  try {
    commit = await runGit(repoRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${gitRef}^{commit}`,
    ]);
  } catch {
    throw new Error(
      `Git ref was not found locally: ${gitRef}. Fetch it first or pass an existing branch, tag, or commit.`,
    );
  }

  if (!/^[0-9a-f]{40,64}$/iu.test(commit)) {
    throw new Error(`Git ref did not resolve to a commit: ${gitRef}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-export-"));
  const checkoutDir = path.join(tempRoot, "checkout");
  let worktreeAdded = false;
  let result: T | undefined;
  let runError: unknown;

  // A generation run is long enough that Ctrl-C is an expected exit. The signal
  // kills the process before any async cleanup below can settle, so the handler
  // tears the worktree down synchronously and then re-raises to keep the
  // conventional signal exit status.
  const handleInterrupt = (signal: NodeJS.Signals): void => {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleInterrupt);
    removeTemporaryGitWorktreeSync(repoRoot, checkoutDir, tempRoot);
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleInterrupt);

  try {
    await runGit(repoRoot, [
      "worktree",
      "add",
      "--detach",
      checkoutDir,
      commit,
    ]);
    worktreeAdded = true;
    result = await run({ checkoutDir, commit });
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  try {
    if (worktreeAdded) {
      await runGit(repoRoot, ["worktree", "remove", "--force", checkoutDir]);
    }
  } catch (error) {
    cleanupError = error;
    // The path is guaranteed to be underneath the mkdtemp directory above.
    await rm(checkoutDir, { force: true, recursive: true }).catch(() => {});
    await runGit(repoRoot, ["worktree", "prune"]).catch(() => {});
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleInterrupt);
    await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
  }

  if (runError !== undefined) {
    if (runError instanceof Error) throw runError;
    throw new Error("OpenWiki export failed with a non-Error value.", {
      cause: runError,
    });
  }
  if (cleanupError !== undefined) {
    throw new Error(
      "OpenWiki generated the export but could not clean up its temporary Git worktree.",
      {
        cause: cleanupError,
      },
    );
  }

  return result as T;
}

/**
 * Publish a generated wiki by staging it beside the destination and renaming it
 * into place. An existing non-empty destination requires `force`; if publishing
 * fails after moving the old directory, it is restored before the error escapes.
 */
export async function publishWikiDirectory(
  sourceWikiDir: string,
  outputDir: string,
  force: boolean,
): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await stat(sourceWikiDir);
  } catch {
    throw new Error(
      `OpenWiki did not generate an output directory: ${sourceWikiDir}`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(
      `Generated OpenWiki output is not a directory: ${sourceWikiDir}`,
    );
  }

  await assertOutputCanBeReplaced(outputDir, force);
  const outputParent = path.dirname(outputDir);
  await mkdir(outputParent, { recursive: true });

  const publishRoot = await mkdtemp(
    path.join(outputParent, ".openwiki-export-"),
  );
  const stagedOutput = path.join(publishRoot, "result");
  const previousOutput = path.join(publishRoot, "previous");
  let previousMoved = false;
  let preserveRecoveryDirectory = false;

  try {
    await cp(sourceWikiDir, stagedOutput, {
      dereference: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });

    if (await pathExists(outputDir)) {
      await rename(outputDir, previousOutput);
      previousMoved = true;
    }

    try {
      await rename(stagedOutput, outputDir);
    } catch (publishError) {
      if (previousMoved) {
        try {
          await rename(previousOutput, outputDir);
          previousMoved = false;
        } catch (restoreError) {
          preserveRecoveryDirectory = true;
          throw new AggregateError(
            [publishError, restoreError],
            `Unable to publish the export or restore the previous output. Recovery data remains at ${previousOutput}`,
            { cause: restoreError },
          );
        }
      }
      throw publishError;
    }
  } finally {
    if (!preserveRecoveryDirectory) {
      await rm(publishRoot, { force: true, recursive: true }).catch(() => {});
    }
  }
}

/**
 * Synchronously detach a temporary worktree and delete its temporary root.
 * Signal handlers cannot await, so every step here is blocking and best-effort:
 * a leaked registration is worse than a slow exit.
 */
export function removeTemporaryGitWorktreeSync(
  repoRoot: string,
  checkoutDir: string,
  tempRoot: string,
): void {
  runGitSync(repoRoot, ["worktree", "remove", "--force", checkoutDir]);
  // The path is guaranteed to be underneath the mkdtemp directory above.
  try {
    rmSync(tempRoot, { force: true, recursive: true });
  } catch {
    // Leaving a temporary directory behind must not mask the interrupt.
  }
  runGitSync(repoRoot, ["worktree", "prune"]);
}

async function assertOutputCanBeReplaced(
  outputDir: string,
  force: boolean,
): Promise<void> {
  let outputStat;
  try {
    outputStat = await lstat(outputDir);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  if (outputStat.isSymbolicLink()) {
    throw new Error(`Export output must not be a symbolic link: ${outputDir}`);
  }
  if (!outputStat.isDirectory()) {
    throw new Error(`Export output path is not a directory: ${outputDir}`);
  }
  if (!force && (await readdir(outputDir)).length > 0) {
    throw new Error(
      `Export output directory is not empty: ${outputDir}. Pass --force to replace it.`,
    );
  }
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

/**
 * Resolve symlinks in the nearest existing ancestor while retaining any
 * not-yet-created suffix. This keeps comparisons reliable on platforms such as
 * macOS where `/var` and `/private/var` name the same directory.
 */
async function canonicalizePotentialPath(filePath: string): Promise<string> {
  let existingAncestor = filePath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return path.join(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function isSamePathOrAncestor(candidate: string, descendant: string): boolean {
  const relative = path.relative(candidate, descendant);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
    cwd,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** Best-effort blocking `git` for the interrupt path; failures are ignored. */
function runGitSync(cwd: string, args: string[]): void {
  try {
    execFileSync("git", ["--no-pager", ...args], { cwd, stdio: "ignore" });
  } catch {
    // The caller is already unwinding; a failed cleanup step must not throw.
  }
}
