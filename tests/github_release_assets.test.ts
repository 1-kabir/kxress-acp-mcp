import { test } from "node:test";
import process from "node:process";
import * as nodeFs from "#fs";
import {
  assertTagMatchesVersion,
  releaseAssetNames,
  stageReleaseAssets,
} from "../scripts/github_release_assets.ts";
import {
  createReleaseArchive,
  extractReleaseArchive,
  releaseNames,
  type ReleaseTarget,
  sha256File,
  sha256Hex,
  validatePackageManifest,
} from "../scripts/release_package.ts";
import { VERSION } from "../src/version.ts";

async function fixtureBundle(root: string, target: ReleaseTarget) {
  const bundle = `${root}/bundle-${target}`;
  await nodeFs.mkdir(bundle);
  const names = releaseNames(VERSION, target);
  const binary = `${root}/fixture-${target}`;
  const nodeLicensePath = `${root}/Node.js-LICENSE.txt`;
  const bytes = new TextEncoder().encode(`native ${target} fixture`);
  await nodeFs.writeBytes(binary, bytes);
  await nodeFs.writeText(nodeLicensePath, "Node runtime license fixture\n");
  const manifest = await createReleaseArchive(`${bundle}/${names.archive}`, {
    binaryPath: binary,
    version: VERSION,
    target,
    commit: "a".repeat(40),
    executableSha256: sha256Hex(bytes),
    nodeLicensePath,
  });
  await nodeFs.writeText(
    `${bundle}/${names.checksum}`,
    `${manifest.archiveSha256}  ${names.archive}\n`,
  );
  await nodeFs.writeText(
    `${bundle}/${names.manifest}`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { bundle, names, manifest, nodeLicensePath };
}

test("GitHub release tag must exactly match source version", () => {
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

test("macOS ARM64 has a closed canonical manifest and archive name", () => {
  const names = releaseNames("0.2.4", "macos-arm64");
  const manifest = validatePackageManifest({
    product: "acp-mcp",
    version: "0.2.4",
    target: "macos-arm64",
    commit: "a".repeat(40),
    executable: "acp-mcp",
    executableSha256: "b".repeat(64),
  });
  if (
    names.executable !== "acp-mcp" ||
    names.archive !== "acp-mcp-0.2.4-macos-arm64.tar.gz" ||
    manifest.target !== "macos-arm64"
  )
    throw new Error("macOS ARM64 release metadata was incorrect");
  let unknownTargetRejected = false;
  try {
    validatePackageManifest({
      ...manifest,
      target: "darwin-aarch64",
    });
  } catch {
    unknownTargetRejected = true;
  }
  if (!unknownTargetRejected) {
    throw new Error("An unknown release target was accepted");
  }
});

test("GitHub assets are self-contained licensed archives for all targets", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-gh-release-" });
  try {
    const targets: ReleaseTarget[] = [
      "windows-x86_64",
      "linux-x86_64",
      "macos-arm64",
    ];
    for (const target of targets) {
      const fixture = await fixtureBundle(root, target);
      const inputManifest = JSON.parse(
        await nodeFs.readText(`${fixture.bundle}/${fixture.names.manifest}`),
      );
      inputManifest.privatePath = "must-not-be-published";
      await nodeFs.writeText(
        `${fixture.bundle}/${fixture.names.manifest}`,
        JSON.stringify(inputManifest),
      );
      const output = `${root}/assets-${target}`;
      const staged = await stageReleaseAssets(
        fixture.bundle,
        output,
        fixture.nodeLicensePath,
      );
      const names = releaseAssetNames(VERSION, target);
      if (
        staged.sort().join("\n") !==
        [names.archive, names.checksum, names.manifest].sort().join("\n")
      )
        throw new Error(`Unexpected GitHub asset set for ${target}`);
      if (
        (await sha256File(`${output}/${names.archive}`)) !==
          fixture.manifest.archiveSha256 ||
        (await nodeFs.readText(`${output}/${names.checksum}`)) !==
          `${fixture.manifest.archiveSha256}  ${names.archive}\n`
      )
        throw new Error(`Published archive checksum mismatch for ${target}`);
      const publishedManifest = JSON.parse(
        await nodeFs.readText(`${output}/${names.manifest}`),
      );
      if (publishedManifest.privatePath !== undefined) {
        throw new Error("Published manifest retained an untrusted extra field");
      }

      const extracted = `${root}/verify-${target}`;
      await nodeFs.mkdir(extracted);
      await extractReleaseArchive(
        `${output}/${names.archive}`,
        target,
        extracted,
      );
      for (const path of [
        "LICENSE",
        "THIRD_PARTY_NOTICES.txt",
        "licenses/Apache-2.0.txt",
        "licenses/MCP-SDK-MIT.txt",
        "licenses/Zod-MIT.txt",
        "manifest.json",
      ]) {
        try {
          await nodeFs.stat(`${extracted}/${path}`);
        } catch {
          throw new Error(`${target} archive omitted ${path}`);
        }
      }
      if (
        !(await nodeFs.readText(`${extracted}/LICENSE`)).includes(
          "DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE",
        ) ||
        !(
          await nodeFs.readText(`${extracted}/licenses/Apache-2.0.txt`)
        ).includes("Apache License") ||
        !(
          await nodeFs.readText(`${extracted}/licenses/MCP-SDK-MIT.txt`)
        ).includes("Copyright (c) 2024-2025 Model Context Protocol") ||
        !(await nodeFs.readText(`${extracted}/licenses/Zod-MIT.txt`)).includes(
          "Copyright (c) 2025 Colin McDonnell",
        )
      )
        throw new Error(`${target} package license notices were incomplete`);
      if (target !== "windows-x86_64" && process.platform !== "win32") {
        const mode = (await nodeFs.stat(`${extracted}/acp-mcp`)).mode;
        if (mode === null || (mode & 0o111) === 0) {
          throw new Error(`${target} archive did not preserve executable mode`);
        }
      }
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("GitHub release staging rejects archive and manifest mismatches", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-gh-release-bad-" });
  try {
    const fixture = await fixtureBundle(root, "windows-x86_64");
    const manifest = { ...fixture.manifest, archiveSha256: "0".repeat(64) };
    await nodeFs.writeText(
      `${fixture.bundle}/${fixture.names.manifest}`,
      JSON.stringify(manifest),
    );
    let rejected = false;
    try {
      await stageReleaseAssets(fixture.bundle, `${root}/assets`);
    } catch (error) {
      rejected = String(error).includes("checksum or manifest mismatch");
    }
    if (!rejected) throw new Error("Mismatched archive manifest was accepted");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});
