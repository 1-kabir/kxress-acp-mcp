import {
  cleanupWorkspaceSnapshot,
  createWorkspaceSnapshot,
} from "../src/workspaces/snapshot.ts";
import {
  cleanupStaleWorkspaceSnapshots,
  parseWorkspaceCleanupArgs,
  workspaceCleanupHelp,
} from "../src/workspaces/stale_cleanup.ts";

const [action, path] = Deno.args;
if (action === "create" && path) {
  const snapshot = await createWorkspaceSnapshot(path);
  console.log(JSON.stringify({
    cwd: snapshot.cwd,
    sourceRoot: snapshot.sourceRoot,
    fileCount: snapshot.fileCount,
    sizeBytes: snapshot.sizeBytes,
    creationMs: Math.round(snapshot.creationMs),
  }));
} else if (action === "cleanup" && path) {
  try {
    await cleanupWorkspaceSnapshot(path);
    console.log(JSON.stringify({ cleaned: true }));
  } catch (error) {
    console.error(
      `Workspace cleanup failed; the path may remain at ${path}: ${error}`,
    );
    Deno.exit(1);
  }
} else if (action === "cleanup-stale") {
  try {
    const options = parseWorkspaceCleanupArgs(Deno.args.slice(1));
    if (options.help) {
      console.log(workspaceCleanupHelp());
    } else {
      const result = await cleanupStaleWorkspaceSnapshots(options);
      console.log(JSON.stringify(result));
      if (result.failed > 0) Deno.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(workspaceCleanupHelp());
    Deno.exit(2);
  }
} else {
  console.error(
    "Usage: deno run --allow-env --allow-read --allow-write --allow-run scripts/planning_workspace.ts <create <repository> | cleanup <workspace> | cleanup-stale [--older-than <duration>] [--delete]>",
  );
  Deno.exit(2);
}
