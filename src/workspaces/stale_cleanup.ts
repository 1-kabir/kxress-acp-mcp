import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
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
  /** Skip creator PID checks for read-only summaries that must not inspect processes. */
  checkCreatorProcess?: boolean;
  remove?: typeof nodeFs.removePath;
}

function join(parent: string, child: string) {
  return `${parent.replace(/[\\/]+$/, "")}${
    process.platform === "win32" ? "\\" : "/"
  }${child}`;
}

function isWorkspaceName(name: string) {
  return /^plan-[a-z0-9]+$/i.test(name);
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (pid === process.pid) return true;
  try {
    if (process.platform === "win32") {
      const result = await new ProcessCommand("tasklist.exe", {
        args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!result.success) return true;
      const output = new TextDecoder().decode(result.stdout);
      return output
        .split(/\r?\n/)
        .some((line) => new RegExp(`^"[^"]+","${pid}",`).test(line));
    }
    const result = await new ProcessCommand("ps", {
      args: ["-p", String(pid), "-o", "pid="],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout).trim();
    const error = new TextDecoder().decode(result.stderr).trim();
    if (!result.success) {
      // procps exits with code 1 and no output when the PID is absent. Treat
      // that ordinary result as dead, while preserving entries if ps itself
      // reports an error we cannot interpret safely.
      return output !== "" || error !== "";
    }
    return output === String(pid);
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
  let rootInfo: nodeFs.FileInfo;
  try {
    rootInfo = await nodeFs.lstat(root);
  } catch (error) {
    if (nodeFs.isErrorCode(error, "ENOENT")) return result;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(
      "Refusing to inspect a linked or non-directory workspace root",
    );
  }
  const canonicalRoot = await nodeFs.realpath(root);
  if (
    canonicalRoot !== root &&
    !(
      process.platform === "win32" &&
      canonicalRoot.toLowerCase() === root.toLowerCase()
    )
  ) {
    throw new Error(
      "Refusing to inspect a workspace root that resolves elsewhere",
    );
  }

  const now = options.now ?? Date.now();
  for await (const entry of nodeFs.readDir(canonicalRoot)) {
    const path = join(canonicalRoot, entry.name);
    if (
      entry.name.endsWith(".json") &&
      isWorkspaceName(entry.name.slice(0, -5))
    )
      continue;

    if (!isWorkspaceName(entry.name)) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        reason: "unrecognized_entry",
      });
      continue;
    }

    let info: nodeFs.FileInfo;
    try {
      info = await nodeFs.lstat(path);
    } catch (error) {
      result.failed++;
      result.entries.push({
        path,
        status: "failed",
        reason: `lstat_failed: ${error}`,
      });
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
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
    let manifestInfo: nodeFs.FileInfo;
    try {
      manifestInfo = await nodeFs.lstat(manifestName);
    } catch (error) {
      result.failed++;
      result.entries.push({
        path,
        status: "failed",
        reason: `manifest_stat_failed: ${error}`,
      });
      continue;
    }
    const createdAt =
      manifest.createdAt ?? manifestInfo.mtime?.getTime() ?? null;
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
    const kind =
      manifest.ownerPid === null || manifest.kind === null
        ? ("legacy" as const)
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
    if (manifest.ownerPid !== null && options.checkCreatorProcess === false) {
      result.skipped++;
      result.entries.push({
        path,
        status: "skipped",
        ageMs,
        kind,
        reason: "creator_process_status_not_checked",
      });
      continue;
    }
    if (
      manifest.ownerPid !== null &&
      (await (options.isProcessAlive ?? processIsAlive)(manifest.ownerPid))
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
