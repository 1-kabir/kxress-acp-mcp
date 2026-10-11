import { join, resolve } from "node:path";
import { VERSION } from "../src/version.ts";
import {
  checksumText,
  extractReleaseArchive,
  releaseNames,
  sha256File,
  validatePackageManifest,
  validateReleaseManifest,
} from "./release_package.ts";
import { isReleaseTarget } from "./release_target.ts";
import { smokeExecutable } from "./release.ts";

const [directoryArg, targetArg] = Deno.args;
if (!directoryArg || !targetArg || !isReleaseTarget(targetArg)) {
  throw new Error(
    "Usage: verify_public_release.ts <download-directory> <supported-target>",
  );
}
const directory = resolve(directoryArg);
const names = releaseNames(VERSION, targetArg);
const expected = new Set([names.archive, names.checksum, names.manifest]);
const actual = new Set<string>();
for await (const entry of Deno.readDir(directory)) {
  if (!entry.isFile) throw new Error("Downloaded release contains a non-file");
  actual.add(entry.name);
}
if (
  actual.size !== expected.size ||
  [...expected].some((name) => !actual.has(name))
) throw new Error("Downloaded release asset set is incomplete or unexpected");

const manifest = validateReleaseManifest(
  JSON.parse(await Deno.readTextFile(join(directory, names.manifest))),
);
if (manifest.version !== VERSION || manifest.target !== targetArg) {
  throw new Error(
    "Downloaded release manifest has the wrong version or target",
  );
}
const archivePath = join(directory, names.archive);
const checksum = await Deno.readTextFile(join(directory, names.checksum));
const archiveHash = await sha256File(archivePath);
if (
  checksum !== checksumText(archiveHash, names.archive) ||
  manifest.archiveSha256 !== archiveHash
) throw new Error("Downloaded archive checksum or manifest does not match");

const extracted = await Deno.makeTempDir({ prefix: "acp-mcp-public-release-" });
try {
  await extractReleaseArchive(archivePath, targetArg, extracted);
  const packageManifest = validatePackageManifest(
    JSON.parse(await Deno.readTextFile(join(extracted, "manifest.json"))),
  );
  const executable = join(extracted, packageManifest.executable);
  if (
    packageManifest.version !== manifest.version ||
    packageManifest.target !== manifest.target ||
    packageManifest.commit !== manifest.commit ||
    packageManifest.executableSha256 !== manifest.executableSha256 ||
    await sha256File(executable) !== manifest.executableSha256
  ) throw new Error("Downloaded executable does not match release manifests");
  if (targetArg !== "windows-x86_64") {
    const mode = (await Deno.stat(executable)).mode;
    if (mode === null || (mode & 0o111) === 0) {
      throw new Error("Downloaded POSIX executable is not executable");
    }
  }
  if (targetArg === "macos-arm64") {
    const output = await new Deno.Command("file", {
      args: [executable],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const description = new TextDecoder().decode(output.stdout);
    if (!output.success || !/Mach-O.*arm64/i.test(description)) {
      throw new Error(
        `Downloaded macOS executable is not ARM64 Mach-O: ${description.trim()}`,
      );
    }
    console.log(description.trim());
  }
  await smokeExecutable(executable);
  console.log(
    `Downloaded ${targetArg} ${VERSION} release package passed checksum, manifest, architecture/mode, version, doctor, and MCP smoke checks.`,
  );
} finally {
  await Deno.remove(extracted, { recursive: true });
}
