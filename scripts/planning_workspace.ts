import {
  cleanupWorkspaceSnapshot,
  createWorkspaceSnapshot,
} from "../src/workspaces/snapshot.ts";

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
} else {
  console.error(
    "Usage: deno run --allow-env --allow-read --allow-write --allow-run scripts/planning_workspace.ts <create <repository> | cleanup <workspace>>",
  );
  Deno.exit(2);
}
