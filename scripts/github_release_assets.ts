import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const supportedTargets = ["windows-x86_64", "linux-x86_64"] as const;

export interface ReleaseManifest {
  product: "acp-mcp";
  version: string;
  target: (typeof supportedTargets)[number];
  commit: string;
  sha256: string;
}

export function assertTagMatchesVersion(tag: string, version: string): void {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid release tag '${tag}'`);
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `Release tag '${tag}' does not match source version '${version}'`,
    );
  }
}

export function releaseAssetNames(
  version: string,
  target: string,
): { executable: string; checksum: string; manifest: string } {
  if (!supportedTargets.includes(target as (typeof supportedTargets)[number])) {
    throw new Error(`Unsupported GitHub release target '${target}'`);
  }
  const windows = target.startsWith("windows-");
  const executable = `acp-mcp-${version}-${target}${windows ? ".exe" : ""}`;
  const stem = executable.replace(/\.exe$/, "");
  return {
    executable,
    checksum: `${executable}.sha256`,
    manifest: `${stem}.manifest.json`,
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function validateManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.product !== "acp-mcp" || typeof manifest.version !== "string" ||
    typeof manifest.target !== "string" ||
    !supportedTargets.includes(
      manifest.target as (typeof supportedTargets)[number],
    ) || typeof manifest.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(
      "Release manifest has invalid product, version, target, commit, or SHA-256 metadata",
    );
  }
  return {
    product: "acp-mcp",
    version: manifest.version,
    target: manifest.target as ReleaseManifest["target"],
    commit: manifest.commit,
    sha256: manifest.sha256,
  };
}

export async function stageReleaseAssets(
  releaseDirectory: string,
  outputDirectory: string,
): Promise<string[]> {
  const manifest = validateManifest(
    JSON.parse(
      await Deno.readTextFile(join(releaseDirectory, "manifest.json")),
    ),
  );
  if (manifest.version !== VERSION) {
    throw new Error(
      `Release bundle version '${manifest.version}' does not match source version '${VERSION}'`,
    );
  }
  const names = releaseAssetNames(manifest.version, manifest.target);
  const artifact = join(releaseDirectory, names.executable);
  const bytes = await Deno.readFile(artifact);
  const hash = sha256Hex(bytes);
  if (hash !== manifest.sha256) {
    throw new Error("Release artifact hash does not match its manifest");
  }
  const checksum = await Deno.readTextFile(
    join(releaseDirectory, `${names.executable}.sha256`),
  );
  if (checksum !== `${hash}  ${names.executable}\n`) {
    throw new Error("Release checksum does not match its artifact");
  }

  await Deno.mkdir(outputDirectory);
  const stagedExecutable = join(outputDirectory, names.executable);
  await Deno.copyFile(artifact, stagedExecutable);
  if (manifest.target === "linux-x86_64") {
    await Deno.chmod(stagedExecutable, 0o755);
  }
  await Deno.writeTextFile(
    join(outputDirectory, names.checksum),
    checksum,
  );
  await Deno.writeTextFile(
    join(outputDirectory, names.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return [names.executable, names.checksum, names.manifest];
}

if (import.meta.main) {
  const [command, ...args] = Deno.args;
  if (command === "check-tag") {
    const tag = Deno.env.get("GITHUB_REF_NAME");
    if (!tag) throw new Error("GITHUB_REF_NAME is required");
    assertTagMatchesVersion(tag, VERSION);
    console.log(`Release tag ${tag} matches source version ${VERSION}`);
  } else if (command === "stage") {
    const target = `${Deno.build.os}-${Deno.build.arch}`;
    if (args.length !== 0) throw new Error("stage takes no arguments");
    const expectedTarget = Deno.env.get("ACPMCP_EXPECTED_RELEASE_TARGET");
    if (expectedTarget && expectedTarget !== target) {
      throw new Error(
        `Native target '${target}' does not match expected release target '${expectedTarget}'`,
      );
    }
    const directory = join(
      projectRoot,
      "dist",
      "releases",
      `acp-mcp-${VERSION}-${target}`,
    );
    const output = join(projectRoot, "dist", "github-release-assets");
    const assets = await stageReleaseAssets(directory, output);
    console.log(`Staged ${assets.map((name) => basename(name)).join(", ")}`);
  } else {
    throw new Error("Usage: github_release_assets.ts check-tag|stage");
  }
}
