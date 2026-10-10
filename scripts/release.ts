import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const windows = Deno.build.os === "windows";
const target = targetId();
const executableName = target.startsWith("windows-")
  ? "acp-mcp.exe"
  : "acp-mcp";
const buildPath = join(projectRoot, "dist", executableName);
const optInTestVariables = [
  "ACPMCP_OPENCODE_TEST",
  "ACPMCP_CODEX_TEST",
  "ACPMCP_ANTIGRAVITY_TEST",
  "ACPMCP_CLAUDE_TEST",
];

export interface ReleaseManifest {
  product: "acp-mcp";
  version: string;
  target: string;
  commit: string;
  sha256: string;
}

export function targetId(os = Deno.build.os, arch = Deno.build.arch): string {
  if ((os !== "windows" && os !== "linux") || arch !== "x86_64") {
    throw new Error(
      `Unsupported native release platform '${os}-${arch}'; supported targets are windows-x86_64 and linux-x86_64`,
    );
  }
  return `${os}-${arch}`;
}

export function artifactName(
  version: string,
  target: string,
  os = Deno.build.os,
): string {
  return `acp-mcp-${version}-${target}${os === "windows" ? ".exe" : ""}`;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function checksumText(hash: string, filename: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("SHA-256 must be 64 lowercase hexadecimal characters");
  }
  return `${hash}  ${filename}\n`;
}

export function assertCleanTreeStatus(status: string): void {
  if (status.trim()) {
    throw new Error(
      "Local release requires a clean working tree (including untracked files). Commit or remove changes before packaging.",
    );
  }
}

/** Ensures release output stays in ordinary dist/releases directories. */
export async function ensureReleaseOutputRoot(
  projectRoot: string,
): Promise<string> {
  const expectedDist = resolve(projectRoot, "dist");
  const expectedReleaseRoot = resolve(expectedDist, "releases");
  const ensurePlainDirectory = async (path: string): Promise<void> => {
    try {
      await Deno.mkdir(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const info = await Deno.lstat(path);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error(`Release output path must be a plain directory: ${path}`);
    }
    const real = resolve(await Deno.realPath(path));
    const normalize = (value: string) =>
      Deno.build.os === "windows" ? value.toLowerCase() : value;
    if (normalize(real) !== normalize(resolve(path))) {
      throw new Error(`Release output path resolves through a link: ${path}`);
    }
  };
  await ensurePlainDirectory(expectedDist);
  await ensurePlainDirectory(expectedReleaseRoot);
  return expectedReleaseRoot;
}

function validateManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.product !== "acp-mcp" || typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    typeof manifest.target !== "string" ||
    typeof manifest.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(
      "Release manifest has invalid product, version, target, commit, or SHA-256 metadata",
    );
  }
  return manifest as unknown as ReleaseManifest;
}

function parseChecksum(text: string, filename: string): string {
  const match = text.trim().match(/^([a-f0-9]{64})[ ]{2}(.+)$/);
  if (!match || match[2] !== filename) {
    throw new Error(`Checksum file does not match artifact '${filename}'`);
  }
  return match[1];
}

async function runCommand(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<void> {
  const status = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: options.cwd ?? projectRoot,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`Command failed (${status.code}): deno ${args.join(" ")}`);
  }
}

async function capture(
  command: string,
  args: string[],
  cwd: string,
): Promise<Deno.CommandOutput> {
  return await new Deno.Command(command, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
}

type VersionProbe = (path: string, cwd: string) => Promise<string | undefined>;

async function probeVersion(
  path: string,
  cwd: string,
): Promise<string | undefined> {
  const result = await capture(path, ["--version"], cwd);
  if (!result.success) return undefined;
  return new TextDecoder().decode(result.stdout).trim();
}

async function gitOutput(args: string[]): Promise<string> {
  const result = await capture("git", args, projectRoot);
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function requireCleanTree(): Promise<void> {
  assertCleanTreeStatus(
    await gitOutput([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]),
  );
}

async function verifyExecutable(path: string, cwd: string): Promise<void> {
  const version = await capture(path, ["--version"], cwd);
  const output = new TextDecoder().decode(version.stdout).trim();
  if (!version.success || output !== `acp-mcp ${VERSION}`) {
    throw new Error(
      `Native executable version mismatch at '${path}': expected acp-mcp ${VERSION}`,
    );
  }
}

async function smokeExecutable(path: string): Promise<void> {
  const cwd = await Deno.makeTempDir({ prefix: "acp-mcp-release-smoke-" });
  try {
    const configPath = join(cwd, "release smoke config.json");
    await Deno.writeTextFile(configPath, JSON.stringify({ agents: {} }));
    await verifyExecutable(path, cwd);
    const help = await capture(path, ["--help"], cwd);
    if (
      !help.success || !new TextDecoder().decode(help.stdout).includes(
        "acp-mcp doctor [--config <path>] [--json]",
      ) || help.stderr.length
    ) throw new Error("Native --help smoke failed");

    const doctor = await capture(path, ["doctor", "--json"], cwd);
    let report: { version?: string; status?: string; checks?: unknown[] };
    try {
      report = JSON.parse(new TextDecoder().decode(doctor.stdout));
    } catch {
      throw new Error("Native doctor --json did not return valid JSON");
    }
    if (
      (doctor.code !== 0 && doctor.code !== 1) ||
      report.version !== VERSION ||
      !["healthy", "warnings", "errors"].includes(report.status ?? "") ||
      !Array.isArray(report.checks)
    ) throw new Error("Native doctor --json smoke failed");

    const child = new Deno.Command(path, {
      args: ["--config", configPath],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const reader = child.stdout.getReader();
    const writer = child.stdin.getWriter();
    const state = { buffer: "" };
    const decoder = new TextDecoder();
    const write = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    const read = async () => {
      while (true) {
        const newline = state.buffer.indexOf("\n");
        if (newline >= 0) {
          const line = state.buffer.slice(0, newline);
          state.buffer = state.buffer.slice(newline + 1);
          if (line.trim()) return JSON.parse(line) as Record<string, unknown>;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("MCP stdout closed before its response");
        state.buffer += decoder.decode(value, { stream: true });
      }
    };
    try {
      await write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "local-release-smoke", version: "1" },
        },
      });
      const initialized = await read();
      if (initialized.id !== 1 || !initialized.result) {
        throw new Error("Native MCP initialize failed");
      }
      await write({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      await write({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const listing = await read();
      const tools = (listing.result as { tools?: unknown[] } | undefined)
        ?.tools;
      if (listing.id !== 2 || tools?.length !== 16) {
        throw new Error("Native MCP tools/list did not return 16 tools");
      }
      await writer.close();
      const status = await Promise.race([
        child.status,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Native MCP server did not exit")),
            10_000,
          )
        ),
      ]);
      if (!status.success) {
        throw new Error("Native MCP server exited unsuccessfully");
      }
    } finally {
      try {
        writer.releaseLock();
      } catch { /* closed */ }
      try {
        reader.releaseLock();
      } catch { /* process exited */ }
      const exited = await Promise.race([
        child.status.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      if (!exited) child.kill("SIGKILL");
      await child.status.catch(() => undefined);
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
}

async function smokeTestExecutable(path: string): Promise<void> {
  const env = Deno.env.toObject();
  env.ACPMCP_NATIVE_EXECUTABLE = path;
  for (const name of optInTestVariables) env[name] = "0";
  const status = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      "--allow-write",
      "--filter",
      "native product works",
      "tests/native_mcp_smoke_test.ts",
    ],
    cwd: projectRoot,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error("Native executable smoke test failed");
}

async function validateSource(): Promise<string> {
  await requireCleanTree();
  const commit = await gitOutput(["rev-parse", "HEAD"]);
  await runCommand(["task", "check"]);
  await runCommand(["task", "test"], { env: offlineTestEnvironment() });
  await runCommand(["lint"]);
  await runCommand(["fmt", "--check"]);
  const diff = await capture("git", ["diff", "--check"], projectRoot);
  if (!diff.success) throw new Error("git diff --check failed");
  await runCommand(["task", "build"]);
  await requireCleanTree();
  await smokeTestExecutable(buildPath);
  return commit;
}

function offlineTestEnvironment(): Record<string, string> {
  const env = Deno.env.toObject();
  for (const name of optInTestVariables) env[name] = "0";
  // Prevent a caller's local smoke override from launching an extra binary test
  // inside the ordinary deterministic suite.
  env.ACPMCP_NATIVE_EXECUTABLE = "";
  return env;
}

async function sha256File(path: string): Promise<string> {
  return sha256Hex(await Deno.readFile(path));
}

async function sameExistingRelease(
  finalDirectory: string,
  manifest: ReleaseManifest,
  filename: string,
): Promise<boolean> {
  try {
    const currentManifest = validateManifest(
      JSON.parse(
        await Deno.readTextFile(join(finalDirectory, "manifest.json")),
      ),
    );
    const currentChecksum = await Deno.readTextFile(
      join(finalDirectory, `${filename}.sha256`),
    );
    const currentHash = await sha256File(join(finalDirectory, filename));
    return currentManifest.product === manifest.product &&
      currentManifest.version === manifest.version &&
      currentManifest.target === manifest.target &&
      currentManifest.commit === manifest.commit &&
      currentManifest.sha256 === manifest.sha256 &&
      currentChecksum === checksumText(manifest.sha256, filename) &&
      currentHash === manifest.sha256;
  } catch {
    return false;
  }
}

async function packageRelease(): Promise<void> {
  const releaseRoot = await ensureReleaseOutputRoot(projectRoot);
  const commit = await validateSource();
  const target = targetId();
  const expectedTarget = Deno.env.get("ACPMCP_EXPECTED_RELEASE_TARGET");
  if (expectedTarget && expectedTarget !== target) {
    throw new Error(
      `Native target '${target}' does not match expected release target '${expectedTarget}'`,
    );
  }
  const filename = artifactName(VERSION, target);
  const buildHash = await sha256File(buildPath);
  const stageDirectory = await Deno.makeTempDir({
    dir: releaseRoot,
    prefix: ".staging-",
  });
  const finalDirectory = join(releaseRoot, `acp-mcp-${VERSION}-${target}`);
  try {
    const stagedArtifact = join(stageDirectory, filename);
    await Deno.copyFile(buildPath, stagedArtifact);
    if (!windows) await Deno.chmod(stagedArtifact, 0o755);
    if (await sha256File(stagedArtifact) !== buildHash) {
      throw new Error("Staged artifact hash differs from the validated build");
    }
    await smokeExecutable(stagedArtifact);
    const manifest: ReleaseManifest = {
      product: "acp-mcp",
      version: VERSION,
      target,
      commit,
      sha256: buildHash,
    };
    await Deno.writeTextFile(
      join(stageDirectory, `${filename}.sha256`),
      checksumText(buildHash, filename),
    );
    await Deno.writeTextFile(
      join(stageDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const manifestOnDisk = validateManifest(
      JSON.parse(
        await Deno.readTextFile(join(stageDirectory, "manifest.json")),
      ),
    );
    const checksumOnDisk = parseChecksum(
      await Deno.readTextFile(join(stageDirectory, `${filename}.sha256`)),
      filename,
    );
    if (
      manifestOnDisk.sha256 !== buildHash || checksumOnDisk !== buildHash ||
      await sha256File(stagedArtifact) !== buildHash
    ) throw new Error("Release package verification failed");

    try {
      const finalInfo = await Deno.lstat(finalDirectory);
      if (!finalInfo.isDirectory || finalInfo.isSymlink) {
        throw new Error(
          `Release output exists but is not a plain directory: ${finalDirectory}`,
        );
      }
      if (await sameExistingRelease(finalDirectory, manifest, filename)) {
        await Deno.remove(stageDirectory, { recursive: true });
        console.log("Local release already exists and matches this build.");
        printReleaseSummary(finalDirectory, filename, manifest);
        return;
      }
      throw new Error(
        `Release output already exists with different contents: ${finalDirectory}. Review and remove it explicitly before retrying.`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.mkdir(releaseRoot, { recursive: true });
    await Deno.rename(stageDirectory, finalDirectory);
    printReleaseSummary(finalDirectory, filename, manifest);
  } finally {
    try {
      await Deno.remove(stageDirectory, { recursive: true });
    } catch { /* Already renamed or removed. */ }
  }
}

function printReleaseSummary(
  directory: string,
  filename: string,
  manifest: ReleaseManifest,
): void {
  console.log(`Version: ${manifest.version}`);
  console.log(`Target: ${manifest.target}`);
  console.log(`Source commit: ${manifest.commit}`);
  console.log(`Artifact: ${join(directory, filename)}`);
  console.log(`SHA-256: ${manifest.sha256}`);
}

export function defaultInstallDestination(
  os = Deno.build.os,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  if (os === "windows") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set; pass --destination <path>");
    }
    return join(localAppData, "Programs", "acp-mcp", "acp-mcp.exe");
  }
  if (os === "linux") {
    const home = env.HOME;
    if (!home) throw new Error("HOME is not set; pass --destination <path>");
    return join(home, ".local", "bin", "acp-mcp");
  }
  throw new Error(
    `Unsupported install platform '${os}'; supported targets are windows-x86_64 and linux-x86_64`,
  );
}

async function readInstallManifest(directory: string): Promise<unknown> {
  try {
    return JSON.parse(
      await Deno.readTextFile(join(directory, "manifest.json")),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const suffix = `-${targetId()}.manifest.json`;
  const matches: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (
      entry.isFile && entry.name.startsWith("acp-mcp-") &&
      entry.name.endsWith(suffix)
    ) matches.push(entry.name);
  }
  if (matches.length !== 1) {
    throw new Error(
      `Release directory must contain manifest.json or exactly one ${targetId()} manifest`,
    );
  }
  return JSON.parse(await Deno.readTextFile(join(directory, matches[0])));
}

async function validateReleaseDirectory(
  directory: string,
  versionProbe: VersionProbe = probeVersion,
): Promise<{
  artifact: string;
  hash: string;
  manifest: ReleaseManifest;
}> {
  const manifest = validateManifest(await readInstallManifest(directory));
  const target = targetId();
  if (manifest.target !== target) {
    throw new Error(
      `Release target '${manifest.target}' does not match this host '${target}'`,
    );
  }
  const filename = artifactName(manifest.version, target);
  const artifact = join(directory, filename);
  const info = await Deno.lstat(artifact);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`Release artifact is not a regular file: ${artifact}`);
  }
  const expectedHash = parseChecksum(
    await Deno.readTextFile(join(directory, `${filename}.sha256`)),
    filename,
  );
  const actualHash = await sha256File(artifact);
  if (manifest.sha256 !== expectedHash || actualHash !== expectedHash) {
    throw new Error(`Release SHA-256 verification failed for '${filename}'`);
  }
  const version = await versionProbe(artifact, directory);
  if (version !== `acp-mcp ${manifest.version}`) {
    throw new Error("Release artifact version does not match its manifest");
  }
  return { artifact, hash: actualHash, manifest };
}

export async function installRelease(
  releaseDirectory: string,
  destination: string,
  versionProbe: VersionProbe = probeVersion,
): Promise<{ hash: string; version: string; destination: string }> {
  const release = await validateReleaseDirectory(
    resolve(releaseDirectory),
    versionProbe,
  );
  const resolvedDestination = resolve(destination);
  if (
    (windows
      ? resolvedDestination.toLowerCase() === release.artifact.toLowerCase()
      : resolvedDestination === release.artifact)
  ) {
    throw new Error(
      "Install destination must differ from the release artifact",
    );
  }
  const parent = dirname(resolvedDestination);
  await Deno.mkdir(parent, { recursive: true });
  try {
    const info = await Deno.lstat(resolvedDestination);
    if (!info.isFile || info.isSymlink) {
      throw new Error(
        `Install destination is not a regular file: ${resolvedDestination}`,
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const staged = join(
    parent,
    `.${executableName.replace(/\.exe$/i, "")}.install-${crypto.randomUUID()}${
      windows ? ".exe" : ""
    }`,
  );
  try {
    await Deno.copyFile(release.artifact, staged);
    if (!windows) await Deno.chmod(staged, 0o755);
    if (await sha256File(staged) !== release.hash) {
      throw new Error("Staged install copy failed SHA-256 verification");
    }
    const stagedVersion = await versionProbe(staged, parent);
    if (stagedVersion !== `acp-mcp ${release.manifest.version}`) {
      throw new Error("Staged install copy reports an unexpected version");
    }
    try {
      await Deno.rename(staged, resolvedDestination);
    } catch (error) {
      throw new Error(
        `Could not replace '${resolvedDestination}'. Close programs using acp-mcp and retry. ${
          String(error)
        }`,
      );
    }
    const installedHash = await sha256File(resolvedDestination);
    if (installedHash !== release.hash) {
      throw new Error(
        "Installed executable SHA-256 differs from release artifact",
      );
    }
    const versionText = await versionProbe(resolvedDestination, parent);
    if (versionText !== `acp-mcp ${release.manifest.version}`) {
      throw new Error("Installed executable version verification failed");
    }
    return {
      hash: installedHash,
      version: versionText,
      destination: resolvedDestination,
    };
  } finally {
    try {
      await Deno.remove(staged);
    } catch { /* Renamed or already removed. */ }
  }
}

function warnIfInstallDirectoryNotOnPath(destination: string): void {
  if (Deno.build.os !== "linux") return;
  const installDirectory = resolve(dirname(destination));
  const pathEntries = (Deno.env.get("PATH") ?? "").split(":")
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry));
  if (!pathEntries.includes(installDirectory)) {
    console.error(
      `Install directory '${installDirectory}' is not on PATH. Add it to your shell PATH to run acp-mcp by name.`,
    );
  }
}

function parseOptions(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name !== "--release-dir" && name !== "--destination") {
      throw new Error(`Unknown install option: ${name}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(name)) {
      throw new Error(`${name} requires one non-empty value`);
    }
    values.set(name, value);
  }
  return values;
}

async function main(args: string[]): Promise<void> {
  const [command = "package", ...rest] = args;
  if (command === "--help" || command === "-h") {
    console.log([
      "Usage:",
      "  deno task release",
      "  deno task install --release-dir <path> [--destination <executable-path>]",
      "",
      "release builds and validates the native Windows or Linux x86_64 executable,",
      "then packages it with SHA-256 and a deterministic manifest.",
    ].join("\n"));
    return;
  }
  if (command === "package") {
    if (rest.length) throw new Error("release package takes no options");
    await packageRelease();
    return;
  }
  if (command === "install") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      console.log(
        "Usage: deno task install --release-dir <path> [--destination <executable-path>]",
      );
      return;
    }
    const options = parseOptions(rest);
    const releaseDirectory = options.get("--release-dir");
    if (!releaseDirectory) {
      throw new Error("install requires --release-dir <path>");
    }
    const destination = options.get("--destination") ??
      defaultInstallDestination();
    const installed = await installRelease(releaseDirectory, destination);
    console.log(`Version: ${installed.version.slice("acp-mcp ".length)}`);
    console.log(`Install destination: ${installed.destination}`);
    console.log(`Installed SHA-256: ${installed.hash}`);
    console.log(`Installed version: ${installed.version}`);
    warnIfInstallDirectoryNotOnPath(installed.destination);
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      `Local release: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}
