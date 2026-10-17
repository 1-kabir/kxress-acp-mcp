import process from "node:process";
import {
  cleanupWorkspaceSnapshot,
  createWorkspaceSnapshot,
} from "../src/workspaces/snapshot.ts";

const [action, path] = process.argv.slice(2);
if (action === "create" && path) {
  const snapshot = await createWorkspaceSnapshot(path);
  console.log(
    JSON.stringify({
      cwd: snapshot.cwd,
      sourceRoot: snapshot.sourceRoot,
      fileCount: snapshot.fileCount,
      sizeBytes: snapshot.sizeBytes,
      creationMs: Math.round(snapshot.creationMs),
    }),
  );
} else if (action === "cleanup" && path) {
  try {
    await cleanupWorkspaceSnapshot(path);
    console.log(JSON.stringify({ cleaned: true }));
  } catch (error) {
    console.error(
      `Workspace cleanup failed; the path may remain at ${path}: ${error}`,
    );
    process.exit(1);
  }
} else {
  console.error(
    "Usage: node scripts/planning_workspace.ts <create <repository> | cleanup <workspace>>",
  );
  process.exit(2);
}
