import {
  cleanupWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  createWorkspaceSnapshot,
} from "../src/workspaces/snapshot.ts";

async function command(cwd: string, args: string[]) {
  const result = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function repository() {
  const path = await Deno.makeTempDir({ prefix: "acp-mcp-source-" });
  await command(path, ["init", "--quiet"]);
  await Deno.writeTextFile(
    `${path}/.gitignore`,
    "ignored-cache/\nignored.txt\n",
  );
  await Deno.writeTextFile(`${path}/tracked.txt`, "committed version");
  await command(path, ["add", ".gitignore", "tracked.txt"]);
  await Deno.writeTextFile(`${path}/tracked.txt`, "current modified version");
  await Deno.writeTextFile(
    `${path}/untracked.txt`,
    "untracked current version",
  );
  await Deno.mkdir(`${path}/ignored-cache`, { recursive: true });
  await Deno.writeTextFile(`${path}/ignored-cache/cache.bin`, "ignored");
  await Deno.writeTextFile(`${path}/ignored.txt`, "ignored");
  return path;
}

Deno.test("snapshot copies current tracked and non-ignored untracked files", async () => {
  const source = await repository();
  let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  try {
    snapshot = await createWorkspaceSnapshot(source);
    if (
      await Deno.readTextFile(`${snapshot.cwd}/tracked.txt`) !==
        "current modified version" ||
      await Deno.readTextFile(`${snapshot.cwd}/.gitignore`) !==
        "ignored-cache/\nignored.txt\n" ||
      await Deno.readTextFile(`${snapshot.cwd}/untracked.txt`) !==
        "untracked current version"
    ) {
      throw new Error(
        "Snapshot did not include the current working-tree state",
      );
    }
    if (
      await Deno.stat(`${snapshot.cwd}/ignored-cache/cache.bin`).then(() =>
        true
      )
        .catch(() => false) ||
      await Deno.stat(`${snapshot.cwd}/ignored.txt`).then(() => true).catch(
        () => false,
      )
    ) throw new Error("Snapshot included an ignored untracked file");
    if (
      await Deno.stat(`${snapshot.cwd}/.git`).then(() => true).catch(() =>
        false
      )
    ) throw new Error("Snapshot copied Git metadata");
    if (snapshot.fileCount !== 3) {
      throw new Error(`Expected three copied files, got ${snapshot.fileCount}`);
    }
  } finally {
    await snapshot?.cleanup();
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("snapshot reads Windows read-only files and keeps them disposable", async () => {
  if (Deno.build.os !== "windows") return;
  const source = await repository();
  const readonlyFile = `${source}\\readonly.txt`;
  let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  try {
    await Deno.writeTextFile(readonlyFile, "read-only source contents");
    await command(source, ["add", "readonly.txt"]);
    const setReadonly = await new Deno.Command("attrib.exe", {
      args: ["+R", readonlyFile],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!setReadonly.success) {
      throw new Error("Could not mark the source file read-only");
    }

    snapshot = await createWorkspaceSnapshot(source);
    const copiedFile = `${snapshot.cwd}\\readonly.txt`;
    if (await Deno.readTextFile(copiedFile) !== "read-only source contents") {
      throw new Error("Snapshot did not copy a read-only source file");
    }

    await snapshot.cleanup();
    snapshot = undefined;
  } finally {
    await new Deno.Command("attrib.exe", {
      args: ["-R", readonlyFile],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => undefined);
    if (snapshot) {
      const copiedFile = `${snapshot.cwd}\\readonly.txt`;
      await new Deno.Command("attrib.exe", {
        args: ["-R", copiedFile],
        stdout: "null",
        stderr: "null",
      }).output().catch(() => undefined);
      await snapshot.cleanup();
    }
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("snapshot mutations do not affect the original and cleanup is safe", async () => {
  const source = await repository();
  let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  try {
    snapshot = await createWorkspaceSnapshot(source);
    await Deno.writeTextFile(`${snapshot.cwd}/tracked.txt`, "planner edit");
    await Deno.remove(`${snapshot.cwd}/untracked.txt`);
    await Deno.writeTextFile(`${snapshot.cwd}/planner-note.txt`, "new file");

    if (
      await Deno.readTextFile(`${source}/tracked.txt`) !==
        "current modified version" ||
      await Deno.readTextFile(`${source}/untracked.txt`) !==
        "untracked current version" ||
      await Deno.stat(`${source}/planner-note.txt`).then(() => true).catch(() =>
        false
      )
    ) throw new Error("Snapshot mutation escaped into the source checkout");

    const workspace = snapshot.cwd;
    await cleanupWorkspaceSnapshot(workspace);
    if (await Deno.stat(workspace).then(() => true).catch(() => false)) {
      throw new Error("Cleanup left the workspace behind");
    }
    snapshot = undefined;
  } finally {
    await snapshot?.cleanup();
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("attempt clones share one source state without sharing mutations", async () => {
  const source = await repository();
  let canonical:
    | Awaited<ReturnType<typeof createWorkspaceSnapshot>>
    | undefined;
  let first: Awaited<ReturnType<typeof cloneWorkspaceSnapshot>> | undefined;
  let second: Awaited<ReturnType<typeof cloneWorkspaceSnapshot>> | undefined;
  try {
    canonical = await createWorkspaceSnapshot(source);
    first = await cloneWorkspaceSnapshot(canonical.cwd);
    second = await cloneWorkspaceSnapshot(canonical.cwd);
    await Deno.writeTextFile(`${first.cwd}/BAD.txt`, "attempt one mutation");
    await Deno.writeTextFile(`${first.cwd}/tracked.txt`, "attempt one edit");
    if (
      await Deno.stat(`${second.cwd}/BAD.txt`).then(() => true).catch(() =>
        false
      ) ||
      await Deno.readTextFile(`${second.cwd}/tracked.txt`) !==
        "current modified version" ||
      await Deno.stat(`${canonical.cwd}/BAD.txt`).then(() => true).catch(() =>
        false
      )
    ) throw new Error("Attempt clone inherited another attempt's mutation");
  } finally {
    await first?.cleanup();
    await second?.cleanup();
    await canonical?.cleanup();
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("concurrent snapshots are distinct and cleanup handles failure paths", async () => {
  const source = await repository();
  const first = await createWorkspaceSnapshot(source);
  const second = await createWorkspaceSnapshot(source);
  try {
    if (first.cwd === second.cwd) {
      throw new Error("Concurrent snapshots shared a workspace path");
    }
    try {
      throw new Error("simulated planner failure");
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "simulated planner failure"
    ) {
      throw error;
    }
  } finally {
    await first.cleanup().catch(() => {});
    await second.cleanup().catch(() => {});
    await Deno.remove(source, { recursive: true });
  }
  if (
    await Deno.stat(first.cwd).then(() => true).catch(() => false) ||
    await Deno.stat(second.cwd).then(() => true).catch(() => false)
  ) throw new Error("Failure-path cleanup left a workspace behind");
});

Deno.test("snapshot skips symlink targets outside the repository", async () => {
  const source = await repository();
  const external = await Deno.makeTempDir({ prefix: "acp-mcp-external-" });
  let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  let linked = false;
  try {
    await Deno.writeTextFile(`${external}/outside.txt`, "must not be copied");
    try {
      await Deno.symlink(
        `${external}/outside.txt`,
        `${source}/outside-link.txt`,
      );
      linked = true;
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotCapable) &&
        !(error instanceof Deno.errors.PermissionDenied)
      ) throw error;
      console.log("Symlink probe skipped: creating symlinks is not permitted");
      return;
    }
    await command(source, ["add", "outside-link.txt"]);
    snapshot = await createWorkspaceSnapshot(source);
    if (
      await Deno.stat(`${snapshot.cwd}/outside-link.txt`).then(() => true)
        .catch(() => false)
    ) throw new Error("Snapshot copied a symlink entry");
    if (
      await Deno.readTextFile(`${external}/outside.txt`) !==
        "must not be copied"
    ) {
      throw new Error("External symlink target was unexpectedly modified");
    }
  } finally {
    await snapshot?.cleanup();
    if (linked) await Deno.remove(`${source}/outside-link.txt`);
    await Deno.remove(source, { recursive: true });
    await Deno.remove(external, { recursive: true });
  }
});

Deno.test("snapshot skips Windows junction targets outside the repository", async () => {
  if (Deno.build.os !== "windows") return;
  const source = await repository();
  const external = await Deno.makeTempDir({
    prefix: "acp-mcp-junction-target-",
  });
  const junction = `${source}\\external-junction`;
  let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  let linked = false;
  try {
    await Deno.writeTextFile(`${external}\\outside.txt`, "outside source");
    const result = await new Deno.Command("powershell.exe", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "New-Item -ItemType Junction -Path $env:ACP_LINK -Target $env:ACP_TARGET | Out-Null",
      ],
      env: { ACP_LINK: junction, ACP_TARGET: external },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      console.log(
        `Junction probe skipped: ${new TextDecoder().decode(result.stderr)}${
          new TextDecoder().decode(result.stdout)
        }`,
      );
      return;
    }
    linked = true;
    await command(source, ["add", "--", "external-junction/outside.txt"]);
    snapshot = await createWorkspaceSnapshot(source);
    if (
      await Deno.stat(`${snapshot.cwd}\\external-junction\\outside.txt`)
        .then(() => true).catch(() => false)
    ) {
      throw new Error(
        "Snapshot followed a Windows junction into an external directory",
      );
    }
    if (
      await Deno.readTextFile(`${external}\\outside.txt`) !== "outside source"
    ) {
      throw new Error("Junction target contents changed");
    }
  } finally {
    await snapshot?.cleanup();
    if (linked) await Deno.remove(junction);
    await Deno.remove(source, { recursive: true });
    await Deno.remove(external, { recursive: true });
  }
});

Deno.test("cleanup removes planner-created junctions without deleting targets", async () => {
  if (Deno.build.os !== "windows") return;
  const source = await repository();
  const external = await Deno.makeTempDir({
    prefix: "acp-mcp-cleanup-target-",
  });
  let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  try {
    await Deno.writeTextFile(`${external}\\keep.txt`, "external data");
    snapshot = await createWorkspaceSnapshot(source);
    const junction = `${snapshot.cwd}\\external-junction`;
    const result = await new Deno.Command("powershell.exe", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "New-Item -ItemType Junction -Path $env:ACP_LINK -Target $env:ACP_TARGET | Out-Null",
      ],
      env: { ACP_LINK: junction, ACP_TARGET: external },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) throw new Error("Could not create test junction");

    await snapshot.cleanup();
    snapshot = undefined;
    if (await Deno.readTextFile(`${external}\\keep.txt`) !== "external data") {
      throw new Error(
        "Workspace cleanup followed its junction into the target",
      );
    }
  } finally {
    await snapshot?.cleanup();
    await Deno.remove(source, { recursive: true });
    await Deno.remove(external, { recursive: true });
  }
});
