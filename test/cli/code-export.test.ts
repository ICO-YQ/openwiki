import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  publishWikiDirectory,
  removeTemporaryGitWorktreeSync,
  resolveCodeExportPaths,
  withTemporaryGitWorktree,
} from "../../src/cli/code-export.ts";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repo = await makeTempDirectory("openwiki-export-repo-");
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "main\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "main"]);
  return repo;
}

describe("resolveCodeExportPaths", () => {
  test("accepts a repository subdirectory and resolves its Git root", async () => {
    const repo = await createRepository();
    const nested = path.join(repo, "packages", "app");
    const output = path.join(
      await makeTempDirectory("openwiki-output-parent-"),
      "wiki",
    );
    await mkdir(nested, { recursive: true });

    const result = await resolveCodeExportPaths(nested, output, false);

    expect(result.repoRoot).toBe(await realpath(repo));
    expect(result.outputDir).toBe(
      path.join(await realpath(path.dirname(output)), path.basename(output)),
    );
  });

  test("refuses a non-empty destination unless force is enabled", async () => {
    const repo = await createRepository();
    const output = await makeTempDirectory("openwiki-existing-output-");
    await writeFile(path.join(output, "keep.txt"), "keep", "utf8");

    await expect(resolveCodeExportPaths(repo, output, false)).rejects.toThrow(
      "Pass --force",
    );
    const result = await resolveCodeExportPaths(repo, output, true);
    expect(result).toEqual({
      outputDir: await realpath(output),
      repoRoot: await realpath(repo),
    });
  });

  test("refuses a destination that contains the repository", async () => {
    const parent = await makeTempDirectory("openwiki-export-parent-");
    const repo = path.join(parent, "repo");
    await mkdir(repo);
    await git(repo, ["init", "-b", "main"]);

    await expect(resolveCodeExportPaths(repo, parent, true)).rejects.toThrow(
      "must not be the repository root or one of its ancestors",
    );
  });
});

describe("withTemporaryGitWorktree", () => {
  test("analyzes the requested ref without switching or cleaning the active worktree", async () => {
    const repo = await createRepository();
    await git(repo, ["switch", "-c", "release"]);
    await writeFile(path.join(repo, "README.md"), "release\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "release"]);
    const releaseCommit = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["switch", "main"]);
    await writeFile(path.join(repo, "working.txt"), "uncommitted\n", "utf8");
    const worktreesBefore = await git(repo, [
      "worktree",
      "list",
      "--porcelain",
    ]);

    await withTemporaryGitWorktree(repo, "release", async (worktree) => {
      expect(worktree.commit).toBe(releaseCommit);
      expect(
        await readFile(path.join(worktree.checkoutDir, "README.md"), "utf8"),
      ).toBe("release\n");
      expect(
        await git(worktree.checkoutDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      ).toBe("HEAD");
    });

    expect(await git(repo, ["branch", "--show-current"])).toBe("main");
    await expect(
      readFile(path.join(repo, "working.txt"), "utf8"),
    ).resolves.toBe("uncommitted\n");
    expect(await git(repo, ["worktree", "list", "--porcelain"])).toBe(
      worktreesBefore,
    );
  });

  test("cleans up the worktree when the analysis fails", async () => {
    const repo = await createRepository();
    const worktreesBefore = await git(repo, [
      "worktree",
      "list",
      "--porcelain",
    ]);

    await expect(
      withTemporaryGitWorktree(repo, "main", () => {
        throw new Error("agent failed");
      }),
    ).rejects.toThrow("agent failed");

    expect(await git(repo, ["worktree", "list", "--porcelain"])).toBe(
      worktreesBefore,
    );
  });

  test("rejects a ref that is not available locally", async () => {
    const repo = await createRepository();

    await expect(
      withTemporaryGitWorktree(repo, "origin/missing", () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toThrow("Git ref was not found locally");
  });

  test("arms an interrupt handler only for the duration of the run", async () => {
    const repo = await createRepository();
    const listenersBefore = process.listenerCount("SIGINT");
    let listenersDuring = 0;

    await withTemporaryGitWorktree(repo, "main", () => {
      listenersDuring = process.listenerCount("SIGINT");
      return Promise.resolve(undefined);
    });

    expect(listenersDuring).toBe(listenersBefore + 1);
    // A leaked handler would keep a removed worktree's cleanup armed for the
    // rest of the process.
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });
});

describe("removeTemporaryGitWorktreeSync", () => {
  test("detaches a leaked worktree and deletes its temporary root", async () => {
    const repo = await createRepository();
    const worktreesBefore = await git(repo, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const tempRoot = await makeTempDirectory("openwiki-export-leak-");
    const checkoutDir = path.join(tempRoot, "checkout");
    await git(repo, ["worktree", "add", "--detach", checkoutDir, "main"]);

    // Synchronous because a signal handler cannot await before the process dies.
    removeTemporaryGitWorktreeSync(repo, checkoutDir, tempRoot);

    expect(await git(repo, ["worktree", "list", "--porcelain"])).toBe(
      worktreesBefore,
    );
    await expect(readdir(tempRoot)).rejects.toThrow();
  });
});

describe("publishWikiDirectory", () => {
  test("publishes a new generated wiki", async () => {
    const source = await makeTempDirectory("openwiki-generated-");
    const output = path.join(
      await makeTempDirectory("openwiki-publish-parent-"),
      "wiki",
    );
    await mkdir(path.join(source, "architecture"));
    await writeFile(
      path.join(source, "quickstart.md"),
      "# Quickstart\n",
      "utf8",
    );
    await writeFile(
      path.join(source, "architecture", "overview.md"),
      "# Architecture\n",
      "utf8",
    );

    await publishWikiDirectory(source, output, false);

    await expect(
      readFile(path.join(output, "quickstart.md"), "utf8"),
    ).resolves.toBe("# Quickstart\n");
    await expect(
      readFile(path.join(output, "architecture", "overview.md"), "utf8"),
    ).resolves.toBe("# Architecture\n");
  });

  test("preserves a non-empty destination without force", async () => {
    const source = await makeTempDirectory("openwiki-generated-");
    const output = await makeTempDirectory("openwiki-existing-");
    await writeFile(path.join(source, "new.md"), "new", "utf8");
    await writeFile(path.join(output, "old.md"), "old", "utf8");

    await expect(publishWikiDirectory(source, output, false)).rejects.toThrow(
      "Pass --force",
    );
    await expect(readFile(path.join(output, "old.md"), "utf8")).resolves.toBe(
      "old",
    );
  });

  test("atomically replaces an existing destination with force", async () => {
    const source = await makeTempDirectory("openwiki-generated-");
    const output = await makeTempDirectory("openwiki-existing-");
    await writeFile(path.join(source, "new.md"), "new", "utf8");
    await writeFile(path.join(output, "old.md"), "old", "utf8");

    await publishWikiDirectory(source, output, true);

    expect(await readdir(output)).toEqual(["new.md"]);
    await expect(readFile(path.join(output, "new.md"), "utf8")).resolves.toBe(
      "new",
    );
  });
});
