import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRuntimeLicenseInventoryMatchesLock,
  parseRuntimeLicenseInventory,
  renderThirdPartyNotices,
  type RuntimeLicenseInventory,
} from "./license_inventory.ts";
import {
  isReleaseTarget,
  isWindowsTarget,
  type ReleaseTarget,
} from "./release_target.ts";

export { renderThirdPartyNotices } from "./license_inventory.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export interface PackageManifest {
  product: "acp-mcp";
  version: string;
  target: ReleaseTarget;
  commit: string;
  executable: string;
  executableSha256: string;
}

export interface ReleaseManifest extends PackageManifest {
  archive: string;
  archiveSha256: string;
}

export interface ReleaseNames {
  executable: string;
  archive: string;
  checksum: string;
  manifest: string;
}

export { type ReleaseTarget } from "./release_target.ts";

export function releaseNames(
  version: string,
  target: string,
): ReleaseNames {
  if (!isReleaseTarget(target)) {
    throw new Error(`Unsupported release target '${target}'`);
  }
  const windows = isWindowsTarget(target);
  const stem = `acp-mcp-${version}-${target}`;
  const executable = windows ? "acp-mcp.exe" : "acp-mcp";
  const archive = `${stem}${windows ? ".zip" : ".tar.gz"}`;
  return {
    executable,
    archive,
    checksum: `${archive}.sha256`,
    manifest: `${stem}.manifest.json`,
  };
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

export function validatePackageManifest(value: unknown): PackageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Package manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.product !== "acp-mcp" || typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    typeof manifest.target !== "string" ||
    !isReleaseTarget(manifest.target) ||
    typeof manifest.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) ||
    typeof manifest.executable !== "string" ||
    manifest.executable !== releaseNames(manifest.version, manifest.target)
        .executable ||
    typeof manifest.executableSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.executableSha256)
  ) throw new Error("Package manifest contains invalid release metadata");
  return {
    product: "acp-mcp",
    version: manifest.version,
    target: manifest.target,
    commit: manifest.commit,
    executable: manifest.executable,
    executableSha256: manifest.executableSha256,
  };
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
  const packageManifest = validatePackageManifest(value);
  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.archive !== "string" ||
    manifest.archive !==
      releaseNames(packageManifest.version, packageManifest.target)
        .archive ||
    typeof manifest.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256)
  ) throw new Error("Release manifest contains invalid archive metadata");
  return {
    ...packageManifest,
    archive: manifest.archive,
    archiveSha256: manifest.archiveSha256,
  };
}

export async function sha256File(path: string): Promise<string> {
  return sha256Hex(await Deno.readFile(path));
}

export async function loadLicenseInventory(
  root = projectRoot,
): Promise<RuntimeLicenseInventory> {
  const inventory = parseRuntimeLicenseInventory(
    await Deno.readTextFile(
      join(root, "licenses", "runtime-dependencies.json"),
    ),
  );
  assertRuntimeLicenseInventoryMatchesLock(
    await Deno.readTextFile(join(root, "deno.lock")),
    await Deno.readTextFile(join(root, "deno.jsonc")),
    inventory,
  );
  return inventory;
}

export async function packageContents(
  packageRoot: string,
  executablePath: string,
  manifest: PackageManifest,
  root = projectRoot,
): Promise<void> {
  const inventory = await loadLicenseInventory(root);
  const executableDestination = join(packageRoot, manifest.executable);
  await Deno.copyFile(executablePath, executableDestination);
  if (!isWindowsTarget(manifest.target)) {
    await Deno.chmod(executableDestination, 0o755);
  }
  await Deno.copyFile(join(root, "LICENSE"), join(packageRoot, "LICENSE"));
  await Deno.writeTextFile(
    join(packageRoot, "THIRD_PARTY_NOTICES.txt"),
    renderThirdPartyNotices(inventory),
  );
  const licenseFiles = new Set(
    inventory.dependencies.flatMap((dependency) => dependency.licenseFiles),
  );
  for (const relative of licenseFiles) {
    const destination = join(packageRoot, relative);
    await Deno.mkdir(join(packageRoot, "licenses"), { recursive: true });
    await Deno.copyFile(join(root, relative), destination);
  }
  await Deno.writeTextFile(
    join(packageRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function runTar(args: string[], cwd: string): Promise<string> {
  const result = await new Deno.Command("tar", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `Archive command failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

const packagedFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "licenses/Apache-2.0.txt",
  "licenses/MCP-SDK-MIT.txt",
  "licenses/Zod-MIT.txt",
  "manifest.json",
] as const;

function expectedArchiveEntries(executable: string): Set<string> {
  return new Set([executable, ...packagedFiles]);
}

export async function validateArchiveEntries(
  archivePath: string,
  target: string,
): Promise<void> {
  const names = releaseNames("0.0.0", target);
  const args = !isWindowsTarget(target)
    ? ["-tzf", archivePath]
    : ["-tf", archivePath];
  const listing = (await runTar(args, Deno.cwd())).trim().split(/\r?\n/)
    .map((name) => name.replace(/^\.\//, ""));
  const expected = expectedArchiveEntries(names.executable);
  const files = listing.filter((entry) => !entry.endsWith("/"));
  const directories = listing.filter((entry) => entry.endsWith("/"));
  const actual = new Set(files);
  if (
    files.length !== actual.size ||
    [...actual].some((entry) => !expected.has(entry)) ||
    [...expected].some((entry) => !actual.has(entry)) ||
    directories.some((entry) => entry !== "licenses/")
  ) {
    throw new Error(
      `Release archive contains missing or unexpected paths; actual: ${
        [...actual].join(", ")
      }; expected: ${
        [...expected].join(", ")
      }; files=${files.length}/${actual.size}; directories=${
        JSON.stringify(directories)
      }`,
    );
  }
  for (const entry of listing) {
    if (
      entry.startsWith("/") || entry.startsWith("\\") ||
      entry.split(/[\\/]/).includes("..") || entry.includes("\\")
    ) throw new Error("Release archive contains an unsafe path");
  }
  const verboseArgs = !isWindowsTarget(target)
    ? ["-tvzf", archivePath]
    : ["-tvf", archivePath];
  const verbose = (await runTar(verboseArgs, Deno.cwd())).trim().split(/\r?\n/);
  if (verbose.length !== listing.length) {
    throw new Error("Could not validate release archive entry types");
  }
  for (const line of verbose) {
    if (!line.startsWith("-") && !line.startsWith("d")) {
      throw new Error("Release archive contains a non-regular entry");
    }
  }
}

export async function extractReleaseArchive(
  archivePath: string,
  target: string,
  destination: string,
): Promise<void> {
  await validateArchiveEntries(archivePath, target);
  const args = !isWindowsTarget(target)
    ? ["-xzf", archivePath, "-C", destination]
    : ["-xf", archivePath, "-C", destination];
  await runTar(args, Deno.cwd());
  const names = releaseNames("0.0.0", target);
  const expected = new Set([
    ...expectedArchiveEntries(names.executable),
    "licenses",
  ]);
  const actual = new Set<string>();
  const visit = async (path: string, relative: string) => {
    for await (const entry of Deno.readDir(path)) {
      const item = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        actual.add(item);
        await visit(join(path, entry.name), item);
      } else if (entry.isFile) actual.add(item);
      else throw new Error("Extracted release package contains a special file");
    }
  };
  await visit(destination, "");
  if (
    [...actual].some((entry) => !expected.has(entry)) ||
    [...expected].some((entry) => !actual.has(entry))
  ) throw new Error("Extracted release package contents are incomplete");
}

export async function createReleaseArchive(
  archivePath: string,
  input: {
    binaryPath: string;
    version: string;
    target: ReleaseTarget;
    commit: string;
    executableSha256: string;
    root?: string;
  },
): Promise<ReleaseManifest> {
  const names = releaseNames(input.version, input.target);
  const packageRoot = await Deno.makeTempDir({ prefix: "acp-mcp-package-" });
  const extracted = await Deno.makeTempDir({
    prefix: "acp-mcp-package-check-",
  });
  try {
    const packageManifest: PackageManifest = {
      product: "acp-mcp",
      version: input.version,
      target: input.target,
      commit: input.commit,
      executable: names.executable,
      executableSha256: input.executableSha256,
    };
    await packageContents(
      packageRoot,
      input.binaryPath,
      packageManifest,
      input.root,
    );
    const createArgs = isWindowsTarget(input.target)
      ? [
        "-a",
        "-cf",
        archivePath,
        "-C",
        packageRoot,
        names.executable,
        ...packagedFiles,
      ]
      : Deno.build.os === "linux"
      ? [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archivePath,
        "-C",
        packageRoot,
        names.executable,
        ...packagedFiles,
      ]
      : [
        "-czf",
        archivePath,
        "-C",
        packageRoot,
        names.executable,
        ...packagedFiles,
      ];
    await runTar(createArgs, Deno.cwd());
    await extractReleaseArchive(archivePath, input.target, extracted);
    if (
      await sha256File(join(extracted, names.executable)) !==
        input.executableSha256
    ) throw new Error("Packaged executable hash does not match the manifest");
    const embedded = validatePackageManifest(
      JSON.parse(await Deno.readTextFile(join(extracted, "manifest.json"))),
    );
    if (JSON.stringify(embedded) !== JSON.stringify(packageManifest)) {
      throw new Error("Embedded package manifest does not match release input");
    }
    const inventory = await loadLicenseInventory(input.root);
    if (
      await Deno.readTextFile(join(extracted, "THIRD_PARTY_NOTICES.txt")) !==
        renderThirdPartyNotices(inventory) ||
      await Deno.readTextFile(join(extracted, "LICENSE")) !==
        await Deno.readTextFile(join(input.root ?? projectRoot, "LICENSE"))
    ) throw new Error("Release archive omitted project or third-party notices");
    for (
      const relative of new Set(
        inventory.dependencies.flatMap((item) => item.licenseFiles),
      )
    ) {
      if (
        await Deno.readTextFile(join(extracted, relative)) !==
          await Deno.readTextFile(join(input.root ?? projectRoot, relative))
      ) throw new Error(`Release archive license text mismatch: ${relative}`);
    }
    const archiveHash = await sha256File(archivePath);
    return {
      ...packageManifest,
      archive: names.archive,
      archiveSha256: archiveHash,
    };
  } finally {
    await Deno.remove(packageRoot, { recursive: true });
    await Deno.remove(extracted, { recursive: true });
  }
}
