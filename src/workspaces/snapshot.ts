export interface WorkspaceSnapshot {
  cwd: string;
  sourceRoot: string;
  fileCount: number;
  sizeBytes: number;
  creationMs: number;
  cleanup(): Promise<void>;
}

interface WorkspaceManifest {
  version: 1;
  cwd: string;
  sourceRoot: string;
}

function join(...parts: string[]) {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  return parts.map((part, index) =>
    index === 0
      ? part.replace(/[\\/]+$/, "")
      : part.replace(/^[\\/]+|[\\/]+$/g, "")
  ).filter(Boolean).join(separator);
}

function splitPath(path: string) {
  return path.split(Deno.build.os === "windows" ? /[\\/]/ : /\//);
}

function isWithin(parent: string, candidate: string) {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const normalize = (path: string) =>
    Deno.build.os === "windows" ? path.toLowerCase() : path;
  const root = normalize(parent.replace(/[\\/]+$/, ""));
  const child = normalize(candidate);
  return child === root || child.startsWith(root + separator);
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const error = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args[0]} failed${error ? `: ${error}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function filePaths(sourceRoot: string) {
  const result = await new Deno.Command("git", {
    args: [
      "-C",
      sourceRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const error = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ls-files failed${error ? `: ${error}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

async function hasSymlinkParent(root: string, relativePath: string) {
  const segments = splitPath(relativePath);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const info = await Deno.lstat(current);
      if (info.isSymlink || !info.isDirectory) return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return true;
      throw error;
    }
  }
  return false;
}

async function removePartialWorkspace(cwd: string, originalError: unknown) {
  try {
    await Deno.remove(cwd, { recursive: true });
  } catch (cleanupError) {
    throw new Error(
      `Snapshot creation failed and cleanup may have left ${cwd}: ${cleanupError}; original error: ${originalError}`,
    );
  }
}

function workspaceRootPath() {
  const tempRoot = Deno.env.get("TEMP") ?? Deno.env.get("TMP") ??
    Deno.env.get("TMPDIR");
  if (!tempRoot) throw new Error("No temporary directory is configured");
  return join(tempRoot, "acp-mcp-workspaces");
}

function samePath(left: string, right: string) {
  return Deno.build.os === "windows"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function validateWorkspaceSnapshot(cwd: string) {
  const expectedRoot = await Deno.realPath(workspaceRootPath());
  const realCwd = await Deno.realPath(cwd);
  const parent = await Deno.realPath(join(realCwd, ".."));
  if (
    !samePath(parent, expectedRoot) ||
    !/^plan-[a-z0-9]+$/i.test(realCwd.split(/[\\/]/).at(-1) ?? "")
  ) {
    throw new Error(
      "Refusing to use a path outside the planning workspace root",
    );
  }
  const manifestPath = `${realCwd}.json`;
  const manifest = JSON.parse(
    await Deno.readTextFile(manifestPath),
  ) as WorkspaceManifest;
  if (
    manifest.version !== 1 ||
    !samePath(await Deno.realPath(manifest.cwd), realCwd)
  ) {
    throw new Error(
      "Planning workspace manifest does not match the requested path",
    );
  }
  return { expectedRoot, realCwd, manifestPath, manifest };
}

async function writeManifest(cwd: string, sourceRoot: string) {
  await Deno.writeTextFile(
    `${cwd}.json`,
    JSON.stringify({ version: 1, cwd, sourceRoot } satisfies WorkspaceManifest),
  );
}

function snapshotHandle(
  cwd: string,
  sourceRoot: string,
  fileCount: number,
  sizeBytes: number,
  startedAt: number,
): WorkspaceSnapshot {
  let cleaned = false;
  return {
    cwd,
    sourceRoot,
    fileCount,
    sizeBytes,
    creationMs: performance.now() - startedAt,
    async cleanup() {
      if (cleaned) return;
      try {
        await cleanupWorkspaceSnapshot(cwd);
        cleaned = true;
      } catch (error) {
        throw new Error(
          `Workspace cleanup failed; path may remain at ${cwd}: ${error}`,
        );
      }
    },
  };
}

/**
 * Copies the current Git working-tree file state into a unique temp directory.
 * Tracked files' current filesystem contents and non-ignored untracked files
 * are included; the Git index is not copied. Untracked ignored files, Git
 * metadata, directories, and symlink/reparse-point entries are excluded. This
 * is a disposable copy, not an OS sandbox.
 */
export async function createWorkspaceSnapshot(
  repositoryPath: string,
): Promise<WorkspaceSnapshot> {
  const startedAt = performance.now();
  const requestedRoot = await Deno.realPath(repositoryPath);
  const gitRootText = await gitOutput(requestedRoot, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const sourceRoot = await Deno.realPath(gitRootText);
  const workspaceRoot = workspaceRootPath();
  await Deno.mkdir(workspaceRoot, { recursive: true });
  const realWorkspaceRoot = await Deno.realPath(workspaceRoot);
  if (isWithin(sourceRoot, realWorkspaceRoot)) {
    throw new Error(
      "Workspace temp root must be outside the source repository",
    );
  }

  const cwd = await Deno.makeTempDir({
    dir: realWorkspaceRoot,
    prefix: "plan-",
  });
  let fileCount = 0;
  let sizeBytes = 0;
  try {
    for (const relativePath of await filePaths(sourceRoot)) {
      const segments = splitPath(relativePath);
      if (
        !relativePath || relativePath.startsWith("/") ||
        /^[a-zA-Z]:/.test(relativePath) ||
        segments.some((part) => part === ".." || part === ".") ||
        segments.some((part) => part.toLowerCase() === ".git") ||
        await hasSymlinkParent(sourceRoot, relativePath)
      ) continue;

      const sourcePath = join(sourceRoot, ...segments);
      const destinationPath = join(cwd, ...segments);
      let info: Deno.FileInfo;
      try {
        info = await Deno.lstat(sourcePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      if (info.isSymlink || !info.isFile) continue;
      const separator = Deno.build.os === "windows" ? "\\" : "/";
      await Deno.mkdir(
        destinationPath.slice(0, destinationPath.lastIndexOf(separator)),
        { recursive: true },
      );
      await Deno.copyFile(sourcePath, destinationPath);
      fileCount++;
      sizeBytes += info.size;
    }
  } catch (error) {
    await removePartialWorkspace(cwd, error);
    throw error;
  }

  try {
    await writeManifest(cwd, sourceRoot);
  } catch (error) {
    await removePartialWorkspace(cwd, error);
    throw error;
  }

  return snapshotHandle(cwd, sourceRoot, fileCount, sizeBytes, startedAt);
}

/** Makes an independent attempt workspace from the immutable canonical snapshot. */
export async function cloneWorkspaceSnapshot(
  sourceSnapshotPath: string,
): Promise<WorkspaceSnapshot> {
  const source = await validateWorkspaceSnapshot(sourceSnapshotPath);
  const startedAt = performance.now();
  const cwd = await Deno.makeTempDir({
    dir: source.expectedRoot,
    prefix: "plan-",
  });
  let fileCount = 0;
  let sizeBytes = 0;

  const copyDirectory = async (sourceDir: string, destinationDir: string) => {
    for await (const entry of Deno.readDir(sourceDir)) {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      const info = await Deno.lstat(sourcePath);
      if (info.isSymlink) continue;
      if (info.isDirectory) {
        await Deno.mkdir(destinationPath);
        await copyDirectory(sourcePath, destinationPath);
      } else if (info.isFile) {
        await Deno.copyFile(sourcePath, destinationPath);
        fileCount++;
        sizeBytes += info.size;
      }
    }
  };

  try {
    await copyDirectory(source.realCwd, cwd);
    await writeManifest(cwd, source.manifest.sourceRoot);
  } catch (error) {
    await removePartialWorkspace(cwd, error);
    throw error;
  }
  return snapshotHandle(
    cwd,
    source.manifest.sourceRoot,
    fileCount,
    sizeBytes,
    startedAt,
  );
}

/** Removes only a direct child workspace created by createWorkspaceSnapshot. */
export async function cleanupWorkspaceSnapshot(cwd: string) {
  const workspace = await validateWorkspaceSnapshot(cwd);
  await Deno.remove(workspace.realCwd, { recursive: true });
  await Deno.remove(workspace.manifestPath);
}
