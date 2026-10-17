import process from "node:process";
import { ProcessCommand, type ProcessOutput } from "#proc";
import * as nodeFs from "#fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import {
  checksumText,
  createReleaseArchive,
  extractReleaseArchive,
  type ReleaseManifest,
  releaseNames,
  sha256File,
  validatePackageManifest,
  validateReleaseManifest,
} from "./release_package.ts";
import { isWindowsTarget, targetId } from "./release_target.ts";

export { targetId } from "./release_target.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const target = targetId();
const windows = isWindowsTarget(target);
const executableName = windows ? "acp-mcp.exe" : "acp-mcp";
const buildPath = join(projectRoot, "dist", executableName);
const optInTestVariables = [
  "ACPMCP_OPENCODE_TEST",
  "ACPMCP_CODEX_TEST",
  "ACPMCP_ANTIGRAVITY_TEST",
  "ACPMCP_CLAUDE_TEST",
];

export type { ReleaseManifest } from "./release_package.ts";
export { checksumText, sha256Hex } from "./release_package.ts";

const validateManifest = validateReleaseManifest;

export function artifactName(
  version: string,
  target: string,
  _os = process.platform,
): string {
  return releaseNames(version, target).archive;
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
  // Canonicalize the trusted checkout root first. On Windows, the supplied
  // path may use an ordinary 8.3 alias; resolve() does not expand it, while
  // realPath() does. Build the guarded output paths from that canonical root
  // so only redirects below the checkout are treated as links.
  const canonicalProjectRoot = resolve(await nodeFs.realpath(projectRoot));
  const expectedDist = resolve(canonicalProjectRoot, "dist");
  const expectedReleaseRoot = resolve(expectedDist, "releases");
  const ensurePlainDirectory = async (path: string): Promise<void> => {
    try {
      await nodeFs.mkdir(path);
    } catch (error) {
      if (!nodeFs.isErrorCode(error, "EEXIST")) throw error;
    }
    const info = await nodeFs.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Release output path must be a plain directory: ${path}`);
    }
    const real = resolve(await nodeFs.realpath(path));
    const normalize = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(real) !== normalize(resolve(path))) {
      throw new Error(`Release output path resolves through a link: ${path}`);
    }
  };
  await ensurePlainDirectory(expectedDist);
  await ensurePlainDirectory(expectedReleaseRoot);
  return expectedReleaseRoot;
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
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const status = await new ProcessCommand(npmCommand, {
    args: ["run", ...args],
    cwd: options.cwd ?? projectRoot,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    shell: process.platform === "win32",
  }).spawn().status;
  if (!status.success) {
    throw new Error(
      `Command failed (${status.code}): npm run ${args.join(" ")}`,
    );
  }
}

async function capture(
  command: string,
  args: string[],
  cwd: string,
): Promise<ProcessOutput> {
  return await new ProcessCommand(command, {
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
      `git ${args.join(" ")} failed: ${new TextDecoder()
        .decode(result.stderr)
        .trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function requireCleanTree(): Promise<void> {
  assertCleanTreeStatus(
    await gitOutput(["status", "--porcelain", "--untracked-files=all"]),
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

export async function smokeExecutable(path: string): Promise<void> {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-mcp-release-smoke-" });
  try {
    const configPath = join(cwd, "release smoke config.json");
    await nodeFs.writeText(configPath, JSON.stringify({ agents: {} }));
    await verifyExecutable(path, cwd);
    const help = await capture(path, ["--help"], cwd);
    if (
      !help.success ||
      !new TextDecoder()
        .decode(help.stdout)
        .includes("acp-mcp doctor [--config <path>] [--json]") ||
      help.stderr.length
    )
      throw new Error("Native --help smoke failed");

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
    )
      throw new Error("Native doctor --json smoke failed");

    const child = new ProcessCommand(path, {
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
          ),
        ),
      ]);
      if (!status.success) {
        throw new Error("Native MCP server exited unsuccessfully");
      }
    } finally {
      try {
        writer.releaseLock();
      } catch {
        /* closed */
      }
      try {
        reader.releaseLock();
      } catch {
        /* process exited */
      }
      const exited = await Promise.race([
        child.status.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      if (!exited) child.kill("SIGKILL");
      await child.status.catch(() => undefined);
    }
  } finally {
    await nodeFs.removePath(cwd, { recursive: true });
  }
}

async function smokeTestExecutable(path: string): Promise<void> {
  const env = { ...process.env };
  env.ACPMCP_NATIVE_EXECUTABLE = path;
  for (const name of optInTestVariables) env[name] = "0";
  const status = await new ProcessCommand(process.execPath, {
    args: [
      "--test",
      "--test-name-pattern",
      "native product works",
      "tests/native_mcp_smoke.test.ts",
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
  await runCommand(["check"]);
  await runCommand(["test"], { env: offlineTestEnvironment() });
  await runCommand(["lint"]);
  await runCommand(["format:check"]);
  const diff = await capture("git", ["diff", "--check"], projectRoot);
  if (!diff.success) throw new Error("git diff --check failed");
  await runCommand(["build"]);
  await runCommand(["build:native"]);
  await requireCleanTree();
  await smokeTestExecutable(buildPath);
  return commit;
}

function offlineTestEnvironment(): Record<string, string> {
  const env = { ...process.env };
  for (const name of optInTestVariables) env[name] = "0";
  // Prevent a caller's local smoke override from launching an extra binary test
  // inside the ordinary deterministic suite.
  env.ACPMCP_NATIVE_EXECUTABLE = "";
  return env;
}

async function sameExistingRelease(
  finalDirectory: string,
  manifest: ReleaseManifest,
  manifestName: string,
): Promise<boolean> {
  try {
    const currentManifest = validateManifest(
      JSON.parse(await nodeFs.readText(join(finalDirectory, manifestName))),
    );
    const currentChecksum = await nodeFs.readText(
      join(finalDirectory, `${manifest.archive}.sha256`),
    );
    const currentHash = await sha256File(
      join(finalDirectory, manifest.archive),
    );
    return (
      currentManifest.product === manifest.product &&
      currentManifest.version === manifest.version &&
      currentManifest.target === manifest.target &&
      currentManifest.commit === manifest.commit &&
      currentManifest.executableSha256 === manifest.executableSha256 &&
      currentManifest.archiveSha256 === manifest.archiveSha256 &&
      currentChecksum ===
        checksumText(manifest.archiveSha256, manifest.archive) &&
      currentHash === manifest.archiveSha256
    );
  } catch {
    return false;
  }
}

async function packageRelease(): Promise<void> {
  const releaseRoot = await ensureReleaseOutputRoot(projectRoot);
  const commit = await validateSource();
  const target = targetId();
  const expectedTarget = process.env["ACPMCP_EXPECTED_RELEASE_TARGET"];
  if (expectedTarget && expectedTarget !== target) {
    throw new Error(
      `Native target '${target}' does not match expected release target '${expectedTarget}'`,
    );
  }
  const names = releaseNames(VERSION, target);
  const executableHash = await sha256File(buildPath);
  const stageDirectory = await nodeFs.makeTempDir({
    dir: releaseRoot,
    prefix: ".staging-",
  });
  const finalDirectory = join(releaseRoot, `acp-mcp-${VERSION}-${target}`);
  try {
    const archivePath = join(stageDirectory, names.archive);
    const manifest = await createReleaseArchive(archivePath, {
      binaryPath: buildPath,
      version: VERSION,
      target: target as ReleaseManifest["target"],
      commit,
      executableSha256: executableHash,
      root: projectRoot,
    });
    const extracted = await nodeFs.makeTempDir({
      prefix: "acp-mcp-release-verify-",
    });
    try {
      await extractReleaseArchive(archivePath, target, extracted);
      const stagedExecutable = join(extracted, names.executable);
      if ((await sha256File(stagedExecutable)) !== executableHash) {
        throw new Error("Packaged executable hash differs from the build");
      }
      if (!windows) {
        const mode = (await nodeFs.stat(stagedExecutable)).mode;
        if (mode === null || (mode & 0o111) === 0) {
          throw new Error("Packaged POSIX executable is not executable");
        }
      }
      if (target === "macos-arm64") {
        const architecture = await capture(
          "file",
          [stagedExecutable],
          extracted,
        );
        const description = new TextDecoder().decode(architecture.stdout);
        if (!architecture.success || !/Mach-O.*arm64/i.test(description)) {
          throw new Error(
            `macOS release executable is not native ARM64 Mach-O: ${description.trim()}`,
          );
        }
      }
      await smokeExecutable(stagedExecutable);
    } finally {
      await nodeFs.removePath(extracted, { recursive: true });
    }
    const manifestName = names.manifest;
    const archiveHash = manifest.archiveSha256;
    await nodeFs.writeText(
      join(stageDirectory, names.checksum),
      checksumText(archiveHash, names.archive),
    );
    await nodeFs.writeText(
      join(stageDirectory, manifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const manifestOnDisk = validateManifest(
      JSON.parse(await nodeFs.readText(join(stageDirectory, manifestName))),
    );
    const checksumOnDisk = parseChecksum(
      await nodeFs.readText(join(stageDirectory, names.checksum)),
      names.archive,
    );
    if (
      manifestOnDisk.archiveSha256 !== archiveHash ||
      manifestOnDisk.executableSha256 !== executableHash ||
      checksumOnDisk !== archiveHash ||
      (await sha256File(archivePath)) !== archiveHash
    )
      throw new Error("Release package verification failed");

    try {
      const finalInfo = await nodeFs.lstat(finalDirectory);
      if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink()) {
        throw new Error(
          `Release output exists but is not a plain directory: ${finalDirectory}`,
        );
      }
      if (await sameExistingRelease(finalDirectory, manifest, manifestName)) {
        await nodeFs.removePath(stageDirectory, { recursive: true });
        console.log("Local release already exists and matches this build.");
        printReleaseSummary(finalDirectory, names.archive, manifest);
        return;
      }
      throw new Error(
        `Release output already exists with different contents: ${finalDirectory}. Review and remove it explicitly before retrying.`,
      );
    } catch (error) {
      if (!nodeFs.isErrorCode(error, "ENOENT")) throw error;
    }
    await nodeFs.mkdir(releaseRoot, { recursive: true });
    await nodeFs.rename(stageDirectory, finalDirectory);
    printReleaseSummary(finalDirectory, names.archive, manifest);
  } finally {
    try {
      await nodeFs.removePath(stageDirectory, { recursive: true });
    } catch {
      /* Already renamed or removed. */
    }
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
  console.log(`Archive: ${join(directory, filename)}`);
  console.log(`Archive SHA-256: ${manifest.archiveSha256}`);
  console.log(`Executable SHA-256: ${manifest.executableSha256}`);
}

export function defaultInstallDestination(
  os = process.platform,
  env: Record<string, string | undefined> = { ...process.env },
): string {
  if (os === "windows" || os === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set; pass --destination <path>");
    }
    return join(localAppData, "Programs", "acp-mcp", "acp-mcp.exe");
  }
  if (os === "linux" || os === "darwin") {
    const home = env.HOME;
    if (!home) throw new Error("HOME is not set; pass --destination <path>");
    return posix.join(home, ".local", "bin", "acp-mcp");
  }
  throw new Error(
    `Unsupported install platform '${os}'; supported targets are windows-x86_64, linux-x86_64, and macos-arm64`,
  );
}

async function readInstallManifest(
  directory: string,
): Promise<ReleaseManifest> {
  const suffix = `-${targetId()}.manifest.json`;
  const matches: string[] = [];
  for await (const entry of nodeFs.readDir(directory)) {
    if (
      entry.isFile() &&
      entry.name.startsWith("acp-mcp-") &&
      entry.name.endsWith(suffix)
    )
      matches.push(entry.name);
  }
  if (matches.length !== 1) {
    throw new Error(
      `Release directory must contain exactly one ${targetId()} manifest`,
    );
  }
  return validateReleaseManifest(
    JSON.parse(await nodeFs.readText(join(directory, matches[0]))),
  );
}

async function validateReleaseDirectory(
  directory: string,
  versionProbe: VersionProbe = probeVersion,
): Promise<{
  artifact: string;
  archivePath: string;
  temporaryDirectory: string;
  hash: string;
  manifest: ReleaseManifest;
}> {
  const manifest = await readInstallManifest(directory);
  const target = targetId();
  if (manifest.target !== target) {
    throw new Error(
      `Release target '${manifest.target}' does not match this host '${target}'`,
    );
  }
  const names = releaseNames(manifest.version, target);
  if (manifest.archive !== names.archive) {
    throw new Error("Release archive name does not match its manifest");
  }
  const archivePath = join(directory, names.archive);
  const info = await nodeFs.lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Release archive is not a regular file: ${archivePath}`);
  }
  const expectedHash = parseChecksum(
    await nodeFs.readText(join(directory, names.checksum)),
    names.archive,
  );
  const actualHash = await sha256File(archivePath);
  if (manifest.archiveSha256 !== expectedHash || actualHash !== expectedHash) {
    throw new Error(
      `Release SHA-256 verification failed for '${names.archive}'`,
    );
  }
  const temporaryDirectory = await nodeFs.makeTempDir({
    prefix: "acp-mcp-install-package-",
  });
  try {
    await extractReleaseArchive(archivePath, target, temporaryDirectory);
    const artifact = join(temporaryDirectory, names.executable);
    const embedded = validatePackageManifest(
      JSON.parse(
        await nodeFs.readText(join(temporaryDirectory, "manifest.json")),
      ),
    );
    if (
      embedded.product !== manifest.product ||
      embedded.version !== manifest.version ||
      embedded.target !== manifest.target ||
      embedded.commit !== manifest.commit ||
      embedded.executable !== manifest.executable ||
      embedded.executableSha256 !== manifest.executableSha256
    ) {
      throw new Error(
        "Embedded package manifest does not match release metadata",
      );
    }
    const executableHash = await sha256File(artifact);
    if (executableHash !== manifest.executableSha256) {
      throw new Error(
        "Packaged executable SHA-256 does not match its manifest",
      );
    }
    const version = await versionProbe(artifact, temporaryDirectory);
    if (version !== `acp-mcp ${manifest.version}`) {
      throw new Error(
        "Packaged executable version does not match its manifest",
      );
    }
    return {
      artifact,
      archivePath,
      temporaryDirectory,
      hash: executableHash,
      manifest,
    };
  } catch (error) {
    await nodeFs.removePath(temporaryDirectory, { recursive: true });
    throw error;
  }
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
  try {
    const resolvedDestination = resolve(destination);
    if (
      windows
        ? resolvedDestination.toLowerCase() ===
          release.archivePath.toLowerCase()
        : resolvedDestination === release.archivePath
    ) {
      throw new Error(
        "Install destination must differ from the release archive",
      );
    }
    const parent = dirname(resolvedDestination);
    await nodeFs.mkdir(parent, { recursive: true });
    try {
      const info = await nodeFs.lstat(resolvedDestination);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(
          `Install destination is not a regular file: ${resolvedDestination}`,
        );
      }
    } catch (error) {
      if (!nodeFs.isErrorCode(error, "ENOENT")) throw error;
    }

    const staged = join(
      parent,
      `.${executableName.replace(
        /\.exe$/i,
        "",
      )}.install-${crypto.randomUUID()}${windows ? ".exe" : ""}`,
    );
    try {
      await nodeFs.copyFile(release.artifact, staged);
      if (!windows) await nodeFs.chmod(staged, 0o755);
      if ((await sha256File(staged)) !== release.hash) {
        throw new Error("Staged install copy failed SHA-256 verification");
      }
      const stagedVersion = await versionProbe(staged, parent);
      if (stagedVersion !== `acp-mcp ${release.manifest.version}`) {
        throw new Error("Staged install copy reports an unexpected version");
      }
      try {
        await nodeFs.rename(staged, resolvedDestination);
      } catch (error) {
        throw new Error(
          `Could not replace '${resolvedDestination}'. Close programs using acp-mcp and retry. ${String(
            error,
          )}`,
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
        await nodeFs.removePath(staged);
      } catch {
        /* Renamed or already removed. */
      }
    }
  } finally {
    await nodeFs.removePath(release.temporaryDirectory, { recursive: true });
  }
}

export function installDirectoryOnPath(
  destination: string,
  pathValue: string,
  os = process.platform,
): boolean {
  const pathApi = os === "windows" ? win32 : posix;
  const separator = os === "windows" ? ";" : ":";
  const normalize = (path: string) => {
    const resolved = pathApi.resolve(path);
    return os === "windows" ? resolved.toLowerCase() : resolved;
  };
  const installDirectory = normalize(pathApi.dirname(destination));
  return pathValue
    .split(separator)
    .filter(Boolean)
    .map(normalize)
    .includes(installDirectory);
}

function warnIfInstallDirectoryNotOnPath(destination: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const installDirectory = posix.resolve(posix.dirname(destination));
  if (!installDirectoryOnPath(destination, process.env["PATH"] ?? "")) {
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
    console.log(
      [
        "Usage:",
        "  npm run release",
        "  npm run install-release -- --release-dir <path> [--destination <executable-path>]",
        "",
        "release builds and validates the native Windows x86_64, Linux x86_64, or macOS ARM64 executable,",
        "then packages it with project and third-party licenses, archive checksum,",
        "and manifest. install consumes the archive/checksum/manifest directory.",
      ].join("\n"),
    );
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
        "Usage: npm run install-release -- --release-dir <path> [--destination <executable-path>]",
      );
      return;
    }
    const options = parseOptions(rest);
    const releaseDirectory = options.get("--release-dir");
    if (!releaseDirectory) {
      throw new Error("install requires --release-dir <path>");
    }
    const destination =
      options.get("--destination") ?? defaultInstallDestination();
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
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Local release: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
