import { test } from "node:test";
import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { createWorkspaceSnapshot } from "../src/workspaces/snapshot.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

async function command(cwd: string, args: string[]) {
  const result = await new ProcessCommand("git", {
    args: ["-C", cwd, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

async function sourceRepository() {
  const source = await nodeFs.makeTempDir({ prefix: "acp-mcp-workspace-api-" });
  await command(source, ["init", "--quiet"]);
  await nodeFs.writeText(`${source}/tracked.txt`, "source");
  await command(source, ["add", "tracked.txt"]);
  return source;
}

async function markStale(path: string) {
  const manifestPath = `${path}.json`;
  const manifest = JSON.parse(await nodeFs.readText(manifestPath)) as Record<
    string,
    unknown
  >;
  manifest.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  manifest.ownerPid = 2_147_483_647;
  await nodeFs.writeText(manifestPath, JSON.stringify(manifest));
}

async function exists(path: string) {
  return await nodeFs
    .lstat(path)
    .then(() => true)
    .catch(() => false);
}

function join(parent: string, child: string) {
  return `${parent.replace(/[\\/]+$/, "")}${
    process.platform === "win32" ? "\\" : "/"
  }${child}`;
}

async function withWorkspaceRoot<T>(fn: () => Promise<T>): Promise<T> {
  const tempRoot = await nodeFs.makeTempDir({
    prefix: "acp-mcp-workspace-api-root-",
  });
  const names = ["TEMP", "TMP", "TMPDIR"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = tempRoot;
  try {
    return await fn();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await nodeFs.removePath(tempRoot, { recursive: true });
  }
}

function connectWorkspaceTools(
  remove?: typeof nodeFs.removePath,
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>,
) {
  const manager = new SessionManager({});
  const server = createMcpServer({}, manager, {
    ...(remove ? { workspaceCleanupRemove: remove } : {}),
    ...(isProcessAlive
      ? { workspaceCleanupIsProcessAlive: isProcessAlive }
      : {}),
  });
  return connectMcp(server).then((mcp) => ({
    manager,
    server,
    mcp,
  }));
}

test("MCP workspace tools inspect, explicitly clean, and repeat safely", async () => {
  await withWorkspaceRoot(async () => {
    const source = await sourceRepository();
    const stale = await createWorkspaceSnapshot(source);
    const recent = await createWorkspaceSnapshot(source);
    const root = join(process.env["TEMP"]!, "acp-mcp-workspaces");
    const unowned = join(root, "plan-unowned");
    const unknown = join(root, "manual-data");
    const external = await nodeFs.makeTempDir({
      prefix: "acp-mcp-workspace-api-target-",
    });
    const outside = await nodeFs.makeTempDir({
      prefix: "acp-mcp-workspace-api-outside-",
    });
    let mcp:
      | Awaited<ReturnType<typeof connectWorkspaceTools>>["mcp"]
      | undefined;
    let manager: SessionManager | undefined;
    let server: ReturnType<typeof createMcpServer> | undefined;
    try {
      await markStale(stale.cwd);
      await nodeFs.mkdir(unowned);
      await nodeFs.mkdir(unknown);
      await nodeFs.writeText(join(external, "keep.txt"), "external data");
      try {
        await nodeFs.symlink(
          external,
          join(stale.cwd, "external-symlink"),
          "dir",
        );
      } catch (error) {
        if (
          !nodeFs.isErrorCode(error, [
            "EACCES",
            "EPERM",
            "ENOTSUP",
            "EINVAL",
          ]) &&
          !nodeFs.isErrorCode(error, ["EACCES", "EPERM"])
        )
          throw error;
      }
      if (process.platform === "win32") {
        const link = join(stale.cwd, "external-junction");
        const result = await new ProcessCommand("powershell.exe", {
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "New-Item -ItemType Junction -Path $env:ACP_LINK -Target $env:ACP_TARGET | Out-Null",
          ],
          env: { ACP_LINK: link, ACP_TARGET: external },
          stdout: "piped",
          stderr: "piped",
        }).output();
        if (!result.success) throw new Error("Could not create test junction");
      }

      ({ manager, server, mcp } = await connectWorkspaceTools(
        undefined,
        () => false,
      ));
      const toolsReply = (await mcp.listTools().response) as {
        result?: { tools?: Array<Record<string, unknown>> };
      };
      const tools = toolsReply.result?.tools ?? [];
      const listing = tools.find(
        (tool) => tool.name === "list_stale_workspaces",
      );
      const cleanup = tools.find(
        (tool) => tool.name === "cleanup_stale_workspaces",
      );
      if (!listing || !cleanup) {
        throw new Error("Workspace MCP tools are absent");
      }
      const listAnnotations = listing.annotations as Record<string, unknown>;
      const cleanupAnnotations = cleanup.annotations as Record<string, unknown>;
      if (
        listAnnotations.readOnlyHint !== true ||
        listAnnotations.destructiveHint !== false ||
        listAnnotations.idempotentHint !== true ||
        listAnnotations.openWorldHint !== false ||
        cleanupAnnotations.readOnlyHint !== false ||
        cleanupAnnotations.destructiveHint !== true ||
        cleanupAnnotations.idempotentHint !== true ||
        cleanupAnnotations.openWorldHint !== false
      )
        throw new Error("Workspace tool annotations do not match behavior");
      const cleanupSchema = cleanup.inputSchema as {
        properties?: Record<string, unknown>;
      };
      if (
        !cleanupSchema.properties?.olderThanMs ||
        cleanupSchema.properties.path ||
        cleanupSchema.properties.workspacePath
      )
        throw new Error("Cleanup must not accept arbitrary filesystem paths");

      const unsafeCall = (await mcp.callTool("cleanup_stale_workspaces", {
        path: outside,
      }).response) as { result?: { isError?: boolean } };
      if (!unsafeCall.result?.isError || !(await exists(outside))) {
        throw new Error("Cleanup accepted an arbitrary path argument");
      }

      const listed = parseToolResult(
        await mcp.callTool("list_stale_workspaces", {}).response,
      );
      const candidates = listed.candidates as Array<Record<string, unknown>>;
      if (
        listed.status !== "completed" ||
        candidates.length !== 1 ||
        candidates[0].workspaceId !== stale.cwd.split(/[\\/]/).at(-1) ||
        candidates[0].kind !== "snapshot" ||
        (listed.skipped as number) < 2 ||
        !(await exists(stale.cwd)) ||
        !(await exists(recent.cwd))
      ) {
        throw new Error(
          `Unexpected stale workspace listing: ${JSON.stringify(listed)}`,
        );
      }
      if (
        JSON.stringify(candidates).includes("manual-data") ||
        JSON.stringify(candidates).includes("plan-unowned")
      )
        throw new Error("Unowned entries appeared as deletable candidates");

      const deleted = parseToolResult(
        await mcp.callTool("cleanup_stale_workspaces", {}).response,
      );
      if (
        deleted.status !== "completed" ||
        deleted.removed !== 1 ||
        deleted.failed !== 0 ||
        (await exists(stale.cwd)) ||
        !(deleted.entries as Array<Record<string, unknown>>).some(
          (entry) =>
            entry.workspaceId === stale.cwd.split(/[\\/]/).at(-1) &&
            entry.status === "removed",
        ) ||
        !(await exists(recent.cwd)) ||
        !(await exists(unowned)) ||
        !(await exists(unknown)) ||
        (await nodeFs.readText(join(external, "keep.txt"))) !== "external data"
      ) {
        throw new Error(
          `Unexpected workspace cleanup result: ${JSON.stringify(deleted)}`,
        );
      }

      const repeated = parseToolResult(
        await mcp.callTool("cleanup_stale_workspaces", {}).response,
      );
      if (repeated.status !== "completed" || repeated.removed !== 0) {
        throw new Error("Repeated cleanup was not a safe no-op");
      }
    } finally {
      await mcp?.close();
      await manager?.closeAll();
      await server?.close();
      await stale.cleanup().catch(() => {});
      await recent.cleanup().catch(() => {});
      await nodeFs.removePath(source, { recursive: true });
      await nodeFs.removePath(external, { recursive: true });
      await nodeFs.removePath(outside, { recursive: true });
    }
  });
});

test("MCP cleanup reports per-workspace failure and continues", async () => {
  await withWorkspaceRoot(async () => {
    const source = await sourceRepository();
    const first = await createWorkspaceSnapshot(source);
    const second = await createWorkspaceSnapshot(source);
    let mcp:
      | Awaited<ReturnType<typeof connectWorkspaceTools>>["mcp"]
      | undefined;
    let manager: SessionManager | undefined;
    let server: ReturnType<typeof createMcpServer> | undefined;
    let failedOnce = false;
    const remove: typeof nodeFs.removePath = async (path, options) => {
      if (!failedOnce && options?.recursive === true) {
        failedOnce = true;
        throw new Error("simulated deletion failure");
      }
      await nodeFs.removePath(path, options);
    };
    try {
      await markStale(first.cwd);
      await markStale(second.cwd);
      ({ manager, server, mcp } = await connectWorkspaceTools(
        remove,
        () => false,
      ));
      const result = parseToolResult(
        await mcp.callTool("cleanup_stale_workspaces", {}).response,
      );
      if (
        result.status !== "failed" ||
        result.failed !== 1 ||
        result.removed !== 1 ||
        (result.failures as Array<Record<string, unknown>>).length !== 1 ||
        (result.entries as Array<Record<string, unknown>>).filter(
          (entry) => entry.status === "removed",
        ).length !== 1 ||
        (await exists(first.cwd)) === (await exists(second.cwd))
      ) {
        throw new Error(
          `Partial cleanup was not reported: ${JSON.stringify(result)}`,
        );
      }
    } finally {
      await mcp?.close();
      await manager?.closeAll();
      await server?.close();
      await first.cleanup().catch(() => {});
      await second.cleanup().catch(() => {});
      await nodeFs.removePath(source, { recursive: true });
    }
  });
});
