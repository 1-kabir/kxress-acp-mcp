import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import { tmpdir } from "node:os";

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
  createdAt?: number;
  ownerPid?: number;
  kind?: "snapshot" | "attempt";
}

function join(...parts: string[]) {
  const separator = process.platform === "win32" ? "\\" : "/";
  return parts
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter(Boolean)
    .join(separator);
}

function splitPath(path: string) {
  return path.split(process.platform === "win32" ? /[\\/]/ : /\//);
}

function isWithin(parent: string, candidate: string) {
  const separator = process.platform === "win32" ? "\\" : "/";
  const normalize = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  const root = normalize(parent.replace(/[\\/]+$/, ""));
  const child = normalize(candidate);
  return child === root || child.startsWith(root + separator);
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await new ProcessCommand("git", {
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
  const result = await new ProcessCommand("git", {
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
      const info = await nodeFs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return true;
    } catch (error) {
      if (nodeFs.isErrorCode(error, "ENOENT")) return true;
      throw error;
    }
  }
  return false;
}

async function removePartialWorkspace(cwd: string, originalError: unknown) {
  try {
    await nodeFs.removePath(cwd, { recursive: true });
  } catch (cleanupError) {
    throw new Error(
      `Snapshot creation failed and cleanup may have left ${cwd}: ${cleanupError}; original error: ${originalError}`,
    );
  }
}

export function configuredTempRoot(
  env: NodeJS.ProcessEnv = { ...process.env },
): string {
  return env.TEMP ?? env.TMP ?? env.TMPDIR ?? tmpdir();
}

/** Returns the canonical acp-mcp workspace root under the configured temp root. */
export async function getWorkspaceRoot() {
  return join(
    await nodeFs.realpath(configuredTempRoot()),
    "acp-mcp-workspaces",
  );
}

async function ensureWorkspaceRoot() {
  const root = await getWorkspaceRoot();
  try {
    const info = await nodeFs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Planning workspace root is not a plain directory");
    }
  } catch (error) {
    if (!nodeFs.isErrorCode(error, "ENOENT")) throw error;
    await nodeFs.mkdir(root);
  }
  const realRoot = await nodeFs.realpath(root);
  if (!samePath(realRoot, root)) {
    throw new Error("Planning workspace root resolves through a link");
  }
  return realRoot;
}

function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function validateWorkspaceSnapshot(cwd: string) {
  const expectedRoot = await ensureWorkspaceRoot();
  const realCwd = await nodeFs.realpath(cwd);
  const parent = await nodeFs.realpath(join(realCwd, ".."));
  if (
    !samePath(parent, expectedRoot) ||
    !/^plan-[a-z0-9]+$/i.test(realCwd.split(/[\\/]/).at(-1) ?? "")
  ) {
    throw new Error(
      "Refusing to use a path outside the planning workspace root",
    );
  }
  const manifestPath = `${realCwd}.json`;
  const manifestInfo = await nodeFs.lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("Planning workspace manifest is not a regular file");
  }
  const manifest = JSON.parse(
    await nodeFs.readText(manifestPath),
  ) as WorkspaceManifest;
  if (
    manifest.version !== 1 ||
    typeof manifest.sourceRoot !== "string" ||
    !manifest.sourceRoot ||
    (manifest.createdAt !== undefined &&
      (!Number.isFinite(manifest.createdAt) || manifest.createdAt <= 0)) ||
    (manifest.ownerPid !== undefined &&
      (!Number.isInteger(manifest.ownerPid) || manifest.ownerPid <= 0)) ||
    (manifest.kind !== undefined &&
      manifest.kind !== "snapshot" &&
      manifest.kind !== "attempt") ||
    !samePath(await nodeFs.realpath(manifest.cwd), realCwd)
  ) {
    throw new Error(
      "Planning workspace manifest does not match the requested path",
    );
  }
  return { expectedRoot, realCwd, manifestPath, manifest };
}

/** Validates ownership and returns the non-secret workspace manifest fields. */
export async function inspectWorkspaceSnapshot(cwd: string) {
  const workspace = await validateWorkspaceSnapshot(cwd);
  const manifestInfo = await nodeFs.lstat(workspace.manifestPath);
  const manifestAgeTime =
    workspace.manifest.createdAt ?? manifestInfo.mtime?.getTime() ?? null;
  return {
    cwd: workspace.realCwd,
    sourceRoot: workspace.manifest.sourceRoot,
    createdAt: manifestAgeTime,
    ownerPid: workspace.manifest.ownerPid ?? null,
    kind: workspace.manifest.kind ?? null,
  };
}

async function writeManifest(
  cwd: string,
  sourceRoot: string,
  kind: "snapshot" | "attempt",
) {
  await nodeFs.writeText(
    `${cwd}.json`,
    JSON.stringify({
      version: 1,
      cwd,
      sourceRoot,
      createdAt: Date.now(),
      ownerPid: process.pid,
      kind,
    } satisfies WorkspaceManifest),
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
  const requestedRoot = await nodeFs.realpath(repositoryPath);
  const gitRootText = await gitOutput(requestedRoot, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const sourceRoot = await nodeFs.realpath(gitRootText);
  const realWorkspaceRoot = await ensureWorkspaceRoot();
  if (isWithin(sourceRoot, realWorkspaceRoot)) {
    throw new Error(
      "Workspace temp root must be outside the source repository",
    );
  }

  const cwd = await nodeFs.makeTempDir({
    dir: realWorkspaceRoot,
    prefix: "plan-",
  });
  let fileCount = 0;
  let sizeBytes = 0;
  try {
    for (const relativePath of await filePaths(sourceRoot)) {
      const segments = splitPath(relativePath);
      if (
        !relativePath ||
        relativePath.startsWith("/") ||
        /^[a-zA-Z]:/.test(relativePath) ||
        segments.some((part) => part === ".." || part === ".") ||
        segments.some((part) => part.toLowerCase() === ".git") ||
        (await hasSymlinkParent(sourceRoot, relativePath))
      )
        continue;

      const sourcePath = join(sourceRoot, ...segments);
      const destinationPath = join(cwd, ...segments);
      let info: nodeFs.FileInfo;
      try {
        info = await nodeFs.lstat(sourcePath);
      } catch (error) {
        if (nodeFs.isErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const separator = process.platform === "win32" ? "\\" : "/";
      await nodeFs.mkdir(
        destinationPath.slice(0, destinationPath.lastIndexOf(separator)),
        { recursive: true },
      );
      await nodeFs.copyFile(sourcePath, destinationPath);
      fileCount++;
      sizeBytes += info.size;
    }
  } catch (error) {
    await removePartialWorkspace(cwd, error);
    throw error;
  }

  try {
    await writeManifest(cwd, sourceRoot, "snapshot");
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
  const cwd = await nodeFs.makeTempDir({
    dir: source.expectedRoot,
    prefix: "plan-",
  });
  let fileCount = 0;
  let sizeBytes = 0;

  const copyDirectory = async (sourceDir: string, destinationDir: string) => {
    for await (const entry of nodeFs.readDir(sourceDir)) {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      const info = await nodeFs.lstat(sourcePath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await nodeFs.mkdir(destinationPath);
        await copyDirectory(sourcePath, destinationPath);
      } else if (info.isFile()) {
        await nodeFs.copyFile(sourcePath, destinationPath);
        fileCount++;
        sizeBytes += info.size;
      }
    }
  };

  try {
    await copyDirectory(source.realCwd, cwd);
    await writeManifest(cwd, source.manifest.sourceRoot, "attempt");
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
export async function cleanupWorkspaceSnapshot(
  cwd: string,
  remove: typeof nodeFs.removePath = nodeFs.removePath,
) {
  const workspace = await validateWorkspaceSnapshot(cwd);
  await remove(workspace.realCwd, { recursive: true });
  await remove(workspace.manifestPath);
}
