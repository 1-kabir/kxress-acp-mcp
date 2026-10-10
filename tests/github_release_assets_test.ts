import {
  assertTagMatchesVersion,
  releaseAssetNames,
  sha256Hex,
  stageReleaseAssets,
} from "../scripts/github_release_assets.ts";
import { VERSION } from "../src/version.ts";

Deno.test("GitHub release tag must exactly match source version", () => {
  assertTagMatchesVersion(`v${VERSION}`, VERSION);
  for (const tag of ["0.2.1", "v0.2.0", "release-v0.2.1", "vNext"]) {
    let rejected = false;
    try {
      assertTagMatchesVersion(tag, VERSION);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`Unexpectedly accepted tag '${tag}'`);
  }
});

Deno.test("GitHub release asset names are target-specific", () => {
  const windows = releaseAssetNames(VERSION, "windows-x86_64");
  const linux = releaseAssetNames(VERSION, "linux-x86_64");
  if (
    windows.executable !== `acp-mcp-${VERSION}-windows-x86_64.exe` ||
    windows.checksum !== `${windows.executable}.sha256` ||
    windows.manifest !== `acp-mcp-${VERSION}-windows-x86_64.manifest.json` ||
    linux.executable !== `acp-mcp-${VERSION}-linux-x86_64` ||
    linux.checksum !== `${linux.executable}.sha256` ||
    linux.manifest !== `acp-mcp-${VERSION}-linux-x86_64.manifest.json`
  ) throw new Error("GitHub release asset names were incorrect");
  let rejected = false;
  try {
    releaseAssetNames(VERSION, "macos-aarch64");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Unsupported release target was accepted");
});

Deno.test("GitHub release staging verifies and preserves local manifest metadata", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-gh-release-" });
  const releaseDirectory = `${root}/bundle`;
  const outputDirectory = `${root}/assets`;
  await Deno.mkdir(releaseDirectory);
  const names = releaseAssetNames(VERSION, "linux-x86_64");
  const executableBytes = new TextEncoder().encode("native linux fixture");
  const hash = sha256Hex(executableBytes);
  const manifest = {
    product: "acp-mcp",
    version: VERSION,
    target: "linux-x86_64",
    commit: "a".repeat(40),
    sha256: hash,
    ignoredExtraField: "must not be published",
  };
  await Deno.writeFile(
    `${releaseDirectory}/${names.executable}`,
    executableBytes,
  );
  await Deno.writeTextFile(
    `${releaseDirectory}/${names.executable}.sha256`,
    `${hash}  ${names.executable}\n`,
  );
  await Deno.writeTextFile(
    `${releaseDirectory}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  try {
    const staged = await stageReleaseAssets(releaseDirectory, outputDirectory);
    if (
      staged.sort().join("\n") !== [
        names.executable,
        names.checksum,
        names.manifest,
      ].sort().join("\n")
    ) throw new Error("Unexpected staged asset names");
    if (
      sha256Hex(
          await Deno.readFile(`${outputDirectory}/${names.executable}`),
        ) !==
        hash ||
      await Deno.readTextFile(`${outputDirectory}/${names.checksum}`) !==
        `${hash}  ${names.executable}\n` ||
      await Deno.readTextFile(`${outputDirectory}/${names.manifest}`) !==
        `${
          JSON.stringify(
            {
              product: manifest.product,
              version: manifest.version,
              target: manifest.target,
              commit: manifest.commit,
              sha256: manifest.sha256,
            },
            null,
            2,
          )
        }\n`
    ) throw new Error("Staged release metadata did not match the local bundle");
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(`${outputDirectory}/${names.executable}`))
        .mode;
      if (mode === null || (mode & 0o111) === 0) {
        throw new Error("Staged Linux executable was not executable");
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("GitHub release staging rejects checksum and manifest mismatches", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-gh-release-bad-" });
  const releaseDirectory = `${root}/bundle`;
  await Deno.mkdir(releaseDirectory);
  const names = releaseAssetNames(VERSION, "windows-x86_64");
  const bytes = new TextEncoder().encode("windows fixture");
  const hash = sha256Hex(bytes);
  await Deno.writeFile(`${releaseDirectory}/${names.executable}`, bytes);
  await Deno.writeTextFile(
    `${releaseDirectory}/${names.executable}.sha256`,
    `${hash}  ${names.executable}\n`,
  );
  await Deno.writeTextFile(
    `${releaseDirectory}/manifest.json`,
    JSON.stringify({
      product: "acp-mcp",
      version: VERSION,
      target: "windows-x86_64",
      commit: "b".repeat(40),
      sha256: "0".repeat(64),
    }),
  );
  try {
    let rejectedManifest = false;
    try {
      await stageReleaseAssets(releaseDirectory, `${root}/assets`);
    } catch (error) {
      rejectedManifest = String(error).includes("manifest");
    }
    if (!rejectedManifest) {
      throw new Error("Mismatched manifest SHA-256 was accepted");
    }
    await Deno.writeTextFile(
      `${releaseDirectory}/${names.executable}.sha256`,
      `${"0".repeat(64)}  ${names.executable}\n`,
    );
    await Deno.writeTextFile(
      `${releaseDirectory}/manifest.json`,
      JSON.stringify({
        product: "acp-mcp",
        version: VERSION,
        target: "windows-x86_64",
        commit: "b".repeat(40),
        sha256: hash,
      }),
    );
    let rejectedChecksum = false;
    try {
      await stageReleaseAssets(releaseDirectory, `${root}/assets`);
    } catch (error) {
      rejectedChecksum = String(error).includes("checksum");
    }
    if (!rejectedChecksum) throw new Error("Mismatched checksum was accepted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
