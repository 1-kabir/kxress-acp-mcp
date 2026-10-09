import {
  cleanupWorkspaceSnapshot,
  getWorkspaceRoot,
  inspectWorkspaceSnapshot,
} from "./snapshot.ts";

export const DEFAULT_STALE_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1000;

export type WorkspaceCleanupStatus =
  | "eligible"
  | "removed"
  | "skipped"
  | "failed";

export interface WorkspaceCleanupEntry {
  path: string;
  status: WorkspaceCleanupStatus;
  ageMs?: number;
  kind?: "snapshot" | "attempt" | "legacy";
  reason?: string;
}

export interface StaleWorkspaceCleanupResult {
  root: string;
  dryRun: boolean;
  olderThanMs: number;
  eligible: number;
  removed: number;
  skipped: number;
  failed: number;
  entries: WorkspaceCleanupEntry[];
}

export interface StaleWorkspaceCleanupOptions {
  /** Defaults to true; deletion must be requested explicitly. */
  delete?: boolean;
  olderThanMs?: number;
  /** Internal deterministic-test seams; CLI callers cannot set these. */
  now?: number;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  remove?: typeof Deno.remove;
}

function join(parent: string, child: string) {
  return `${parent.replace(/[\\/]+$/, "")}${
    Deno.build.os === "windows" ? "\\" : "/"
  }${child}`;
}

function isWorkspaceName(name: string) {
  return /^plan-[a-z0-9]+$/i.test(name);
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (pid === Deno.pid) return true;
  try {
    if (Deno.build.os === "windows") {
      const result = await new Deno.Command("tasklist.exe", {
        args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!result.success) return true;
      const output = new TextDecoder().decode(result.stdout);
      return output.split(/\r?\n/).some((line) =>
        new RegExp(`^"[^"]+","${pid}",`).test(line)
      );
    }
    const result = await new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "pid="],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return true;
    return new TextDecoder().decode(result.stdout).trim() === String(pid);
  } catch {
    // If liveness cannot be checked, preserve the workspace conservatively.
    return true;
  }
}

function ageResult(
  options: StaleWorkspaceCleanupOptions,
): StaleWorkspaceCleanupResult {
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_WORKSPACE_AGE_MS;
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error("olderThanMs must be a positive finite duration");
  }
  return {
    root: "",
    dryRun: options.delete !== true,
    olderThanMs,
    eligible: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    entries: [],
  };
}

/**
 * Inspects the fixed acp-mcp temp root. Only plan-* directories with a valid
 * matching workspace manifest can be eligible. Unmarked and malformed entries
 * are preserved. Deletion is a dry run unless `delete: true` is passed.
 */
export async function cleanupStaleWorkspaceSnapshots(
  options: StaleWorkspaceCleanupOptions = {},
): Promise<StaleWorkspaceCleanupResult> {
  const result = ageResult(options);
  const root = await getWorkspaceRoot();
  result.root = root;
  let rootInfo: Deno.FileInfo;
  try {
    rootInfo = await Deno.lstat(root);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return result;
    throw error;
  }
  if (!rootInfo.isDirectory || rootInfo.isSymlink) {
    throw new Error(
      "Refusing to inspect a linked or non-directory workspace root",
    );
  }
  const canonicalRoot = await Deno.realPath(root);
  if (
    canonicalRoot !== root &&
    !(Deno.build.os === "windows" &&
      canonicalRoot.toLowerCase() === root.toLowerCase())
  ) {
    throw new Error(
      "Refusing to inspect a workspace root that resolves elsewhere",
    );
  }

  const now = options.now ?? Date.now();
  for await (const entry of Deno.readDir(canonicalRoot)) {
    const path = join(canonicalRoot, entry.name);
    if (
      entry.name.endsWith(".json") &&
      isWorkspaceName(entry.name.slice(0, -5))
    ) continue;

    if (!isWorkspaceName(entry.name)) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        reason: "unrecognized_entry",
      });
      continue;
    }

    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      result.failed++;
      result.entries.push({
        path,
        status: "failed",
        reason: `lstat_failed: ${error}`,
      });
      continue;
    }
    if (!info.isDirectory || info.isSymlink) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        reason: "not_plain_workspace_directory",
      });
      continue;
    }

    let manifest: Awaited<ReturnType<typeof inspectWorkspaceSnapshot>>;
    try {
      manifest = await inspectWorkspaceSnapshot(path);
    } catch {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        reason: "missing_or_invalid_ownership_manifest",
      });
      continue;
    }
    const manifestName = `${manifest.cwd}.json`;
    let manifestInfo: Deno.FileInfo;
    try {
      manifestInfo = await Deno.lstat(manifestName);
    } catch (error) {
      result.failed++;
      result.entries.push({
        path,
        status: "failed",
        reason: `manifest_stat_failed: ${error}`,
      });
      continue;
    }
    const createdAt = manifest.createdAt ?? manifestInfo.mtime?.getTime() ??
      null;
    if (createdAt === null || createdAt > now) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        reason: "unknown_or_future_creation_time",
      });
      continue;
    }
    const ageMs = now - createdAt;
    const kind = manifest.ownerPid === null || manifest.kind === null
      ? "legacy" as const
      : manifest.kind;
    if (ageMs < result.olderThanMs) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        ageMs,
        kind,
        reason: "younger_than_threshold",
      });
      continue;
    }
    if (
      manifest.ownerPid !== null &&
      await (options.isProcessAlive ?? processIsAlive)(manifest.ownerPid)
    ) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        ageMs,
        kind,
        reason: "creator_process_is_alive",
      });
      continue;
    }

    if (!options.delete) {
      result.eligible++;
      result.entries.push({
        path,
        status: "eligible",
        ageMs,
        kind,
        reason: "dry_run",
      });
      continue;
    }
    try {
      await cleanupWorkspaceSnapshot(path, options.remove);
      result.removed++;
      result.entries.push({ path, status: "removed", ageMs, kind });
    } catch (error) {
      result.failed++;
      result.entries.push({
        path,
        status: "failed",
        ageMs,
        kind,
        reason: `cleanup_failed: ${error}`,
      });
    }
  }
  return result;
}
