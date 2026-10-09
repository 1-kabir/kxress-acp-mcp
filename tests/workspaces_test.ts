import {
  cleanupWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  createWorkspaceSnapshot,
} from "../src/workspaces/snapshot.ts";
import {
  cleanupStaleWorkspaceSnapshots,
  DEFAULT_STALE_WORKSPACE_AGE_MS,
} from "../src/workspaces/stale_cleanup.ts";

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

async function withIsolatedWorkspaceRoot<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const tempRoot = await Deno.makeTempDir({ prefix: "acp-mcp-cleaner-test-" });
  const names = ["TEMP", "TMP", "TMPDIR"];
  const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
  for (const name of names) Deno.env.set(name, tempRoot);
  try {
    return await fn(tempRoot);
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(tempRoot, { recursive: true });
  }
}

async function markStale(
  path: string,
  ownerPid: number | undefined = 2_147_483_647,
) {
  const manifestPath = `${path}.json`;
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as Record<
    string,
    unknown
  >;
  manifest.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  if (ownerPid === undefined) delete manifest.ownerPid;
  else manifest.ownerPid = ownerPid;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
}

async function exists(path: string) {
  return await Deno.lstat(path).then(() => true).catch(() => false);
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

Deno.test("stale cleanup on an empty root is a no-op", async () => {
  await withIsolatedWorkspaceRoot(async (tempRoot) => {
    const result = await cleanupStaleWorkspaceSnapshots();
    if (
      result.dryRun !== true || result.eligible !== 0 || result.removed !== 0 ||
      result.skipped !== 0 || result.failed !== 0 ||
      await exists(`${tempRoot}/acp-mcp-workspaces`)
    ) throw new Error("Empty cleanup should not create or mutate the root");
  });
});

Deno.test("stale cleanup defaults to dry run and preserves recent workspaces", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const snapshot = await createWorkspaceSnapshot(source);
    try {
      const result = await cleanupStaleWorkspaceSnapshots();
      if (
        result.dryRun !== true || result.olderThanMs !==
          DEFAULT_STALE_WORKSPACE_AGE_MS ||
        result.eligible !== 0 ||
        result.skipped !== 1 || !await exists(snapshot.cwd)
      ) throw new Error("Recent workspace was not safely skipped");
    } finally {
      await snapshot.cleanup();
      await Deno.remove(source, { recursive: true });
    }
  });
});

Deno.test("stale cleanup reports dry-run candidates and deletes only on request", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const snapshot = await createWorkspaceSnapshot(source);
    try {
      await markStale(snapshot.cwd);
      const dryRun = await cleanupStaleWorkspaceSnapshots({
        olderThanMs: 24 * 60 * 60 * 1000,
        isProcessAlive: () => false,
      });
      if (
        !dryRun.dryRun || dryRun.eligible !== 1 || dryRun.removed !== 0 ||
        dryRun.entries[0]?.status !== "eligible" || !await exists(snapshot.cwd)
      ) {
        throw new Error(
          "Dry run did not preserve and report the stale workspace",
        );
      }

      const deleted = await cleanupStaleWorkspaceSnapshots({
        delete: true,
        olderThanMs: 24 * 60 * 60 * 1000,
        isProcessAlive: () => false,
      });
      if (
        deleted.removed !== 1 || deleted.failed !== 0 ||
        await exists(snapshot.cwd) || await exists(`${snapshot.cwd}.json`)
      ) throw new Error("Explicit stale cleanup did not remove the workspace");
    } finally {
      await snapshot.cleanup().catch(() => {});
      await Deno.remove(source, { recursive: true });
    }
  });
});

Deno.test("stale cleanup preserves unmarked and outside-root entries", async () => {
  await withIsolatedWorkspaceRoot(async (tempRoot) => {
    const source = await repository();
    const snapshot = await createWorkspaceSnapshot(source);
    const unknown = `${tempRoot}/acp-mcp-workspaces/plan-unmarked`;
    const prefixCollision = `${tempRoot}/acp-mcp-workspaces-evil`;
    const outside = await Deno.makeTempDir({ prefix: "acp-mcp-outside-" });
    try {
      await markStale(snapshot.cwd);
      await Deno.mkdir(unknown);
      await Deno.mkdir(prefixCollision);
      await Deno.writeTextFile(`${prefixCollision}/keep.txt`, "outside");
      const result = await cleanupStaleWorkspaceSnapshots({
        delete: true,
        isProcessAlive: () => false,
      });
      if (
        result.removed !== 1 || !await exists(unknown) ||
        !await exists(`${prefixCollision}/keep.txt`)
      ) throw new Error("Unknown or prefix-collision directories were removed");
      let refused = false;
      try {
        await cleanupWorkspaceSnapshot(outside);
      } catch {
        refused = true;
      }
      if (!refused || !await exists(outside)) {
        throw new Error(
          "Explicit cleanup accepted a path outside the workspace root",
        );
      }
    } finally {
      await snapshot.cleanup().catch(() => {});
      await Deno.remove(source, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("stale cleanup protects a live creator process", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const snapshot = await createWorkspaceSnapshot(source);
    try {
      await markStale(snapshot.cwd, Deno.pid);
      const result = await cleanupStaleWorkspaceSnapshots({ delete: true });
      if (
        result.skipped !== 1 || result.removed !== 0 ||
        result.entries[0]?.reason !== "creator_process_is_alive" ||
        !await exists(snapshot.cwd)
      ) throw new Error("Stale cleanup did not protect the live owner");
    } finally {
      await snapshot.cleanup();
      await Deno.remove(source, { recursive: true });
    }
  });
});

Deno.test("read-only stale inspection can avoid checking creator processes", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const snapshot = await createWorkspaceSnapshot(source);
    let processCheckCalled = false;
    try {
      await markStale(snapshot.cwd, Deno.pid);
      const result = await cleanupStaleWorkspaceSnapshots({
        checkCreatorProcess: false,
        isProcessAlive: () => {
          processCheckCalled = true;
          return true;
        },
      });
      if (
        processCheckCalled || result.skipped !== 1 || result.eligible !== 0 ||
        result.entries[0]?.reason !== "creator_process_status_not_checked" ||
        !await exists(snapshot.cwd)
      ) {
        throw new Error(
          "Read-only inspection probed or misclassified the creator process",
        );
      }
    } finally {
      await snapshot.cleanup();
      await Deno.remove(source, { recursive: true });
    }
  });
});

Deno.test("legacy manifests use their file timestamp and remain eligible", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const snapshot = await createWorkspaceSnapshot(source);
    try {
      await markStale(snapshot.cwd, undefined);
      const manifestPath = `${snapshot.cwd}.json`;
      const legacy = JSON.parse(
        await Deno.readTextFile(manifestPath),
      ) as Record<
        string,
        unknown
      >;
      delete legacy.createdAt;
      delete legacy.kind;
      await Deno.writeTextFile(manifestPath, JSON.stringify(legacy));
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await Deno.utime(manifestPath, old, old);
      const result = await cleanupStaleWorkspaceSnapshots({
        olderThanMs: 24 * 60 * 60 * 1000,
      });
      if (
        result.eligible !== 1 || result.entries[0]?.kind !== "legacy" ||
        !await exists(snapshot.cwd)
      ) throw new Error("Legacy owned workspace was not reported safely");
    } finally {
      await snapshot.cleanup();
      await Deno.remove(source, { recursive: true });
    }
  });
});

Deno.test("stale cleanup continues after a deletion failure", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const first = await createWorkspaceSnapshot(source);
    const second = await createWorkspaceSnapshot(source);
    try {
      await markStale(first.cwd);
      await markStale(second.cwd);
      let failedOnce = false;
      const result = await cleanupStaleWorkspaceSnapshots({
        delete: true,
        isProcessAlive: () => false,
        remove: async (path, options) => {
          if (!failedOnce && options?.recursive === true) {
            failedOnce = true;
            throw new Error("simulated delete failure");
          }
          await Deno.remove(path, options);
        },
      });
      if (
        result.failed !== 1 || result.removed !== 1 ||
        (await exists(first.cwd)) === (await exists(second.cwd))
      ) throw new Error("A failed deletion prevented later cleanup");
    } finally {
      await first.cleanup().catch(() => {});
      await second.cleanup().catch(() => {});
      await Deno.remove(source, { recursive: true });
    }
  });
});

Deno.test("stale cleanup removes a junction entry without deleting its target", async () => {
  if (Deno.build.os !== "windows") return;
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const external = await Deno.makeTempDir({
      prefix: "acp-mcp-stale-junction-",
    });
    const snapshot = await createWorkspaceSnapshot(source);
    try {
      await Deno.writeTextFile(`${external}\\keep.txt`, "external data");
      const junction = `${snapshot.cwd}\\external-junction`;
      const linked = await new Deno.Command("powershell.exe", {
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
      if (!linked.success) {
        throw new Error("Could not create the test junction");
      }
      await markStale(snapshot.cwd);
      const result = await cleanupStaleWorkspaceSnapshots({
        delete: true,
        isProcessAlive: () => false,
      });
      if (
        result.removed !== 1 || await exists(snapshot.cwd) ||
        await Deno.readTextFile(`${external}\\keep.txt`) !== "external data"
      ) throw new Error("Stale cleanup followed the junction target");
    } finally {
      await snapshot.cleanup().catch(() => {});
      await Deno.remove(source, { recursive: true });
      await Deno.remove(external, { recursive: true });
    }
  });
});

Deno.test("stale cleanup removes a symlink entry without deleting its target", async () => {
  await withIsolatedWorkspaceRoot(async () => {
    const source = await repository();
    const external = await Deno.makeTempDir({
      prefix: "acp-mcp-stale-symlink-",
    });
    const snapshot = await createWorkspaceSnapshot(source);
    let linked = false;
    try {
      const externalFile = `${external}/keep.txt`;
      const symlink = `${snapshot.cwd}/external-link`;
      await Deno.writeTextFile(externalFile, "external data");
      try {
        await Deno.symlink(external, symlink, { type: "dir" });
        linked = true;
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotCapable) &&
          !(error instanceof Deno.errors.PermissionDenied)
        ) throw error;
        console.log(
          "Symlink cleanup probe skipped: symlink creation is unavailable",
        );
        return;
      }
      await markStale(snapshot.cwd);
      const result = await cleanupStaleWorkspaceSnapshots({
        delete: true,
        isProcessAlive: () => false,
      });
      if (
        result.removed !== 1 || await exists(snapshot.cwd) ||
        await Deno.readTextFile(externalFile) !== "external data"
      ) throw new Error("Stale cleanup followed the symlink target");
    } finally {
      await snapshot.cleanup().catch(() => {});
      if (linked && await exists(`${snapshot.cwd}/external-link`)) {
        await Deno.remove(`${snapshot.cwd}/external-link`);
      }
      await Deno.remove(source, { recursive: true });
      await Deno.remove(external, { recursive: true });
    }
  });
});
