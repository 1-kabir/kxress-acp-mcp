import { test } from "node:test";
import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import {
  artifactName,
  assertCleanTreeStatus,
  checksumText,
  defaultInstallDestination,
  ensureReleaseOutputRoot,
  installDirectoryOnPath,
  installRelease,
  sha256Hex,
  targetId,
} from "../scripts/release.ts";
import { VERSION } from "../src/version.ts";
import {
  createReleaseArchive,
  releaseNames,
  type ReleaseTarget,
} from "../scripts/release_package.ts";
import {
  assertRuntimeLicenseInventoryMatchesLock,
  parseRuntimeLicenseInventory,
  renderThirdPartyNotices,
} from "../scripts/license_inventory.ts";

test("release target and artifact names encode native platform/version", () => {
  if (
    targetId("windows", "x86_64") !== "windows-x86_64" ||
    targetId("linux", "x86_64") !== "linux-x86_64" ||
    targetId("darwin", "aarch64") !== "macos-arm64" ||
    artifactName("0.2.4", "windows-x86_64", "windows") !==
      "acp-mcp-0.2.4-windows-x86_64.zip" ||
    artifactName("0.2.4", "linux-x86_64", "linux") !==
      "acp-mcp-0.2.4-linux-x86_64.tar.gz" ||
    artifactName("0.2.4", "macos-arm64", "darwin") !==
      "acp-mcp-0.2.4-macos-arm64.tar.gz" ||
    releaseNames("0.2.4", "macos-arm64").executable !== "acp-mcp" ||
    releaseNames("0.2.4", "macos-arm64").checksum !==
      "acp-mcp-0.2.4-macos-arm64.tar.gz.sha256" ||
    releaseNames("0.2.4", "macos-arm64").manifest !==
      "acp-mcp-0.2.4-macos-arm64.manifest.json"
  )
    throw new Error("Release naming did not match the native target");
  for (const [os, arch] of [
    ["darwin", "x86_64"],
    ["linux", "aarch64"],
    ["windows", "aarch64"],
  ]) {
    let unsupportedRejected = false;
    try {
      targetId(os, arch);
    } catch (error) {
      unsupportedRejected =
        String(error).includes("supported targets") &&
        String(error).includes("macos-arm64");
    }
    if (!unsupportedRejected) {
      throw new Error(`Unsupported native target was accepted: ${os}-${arch}`);
    }
  }
});

test("default install locations are user-local on all supported targets", () => {
  if (process.platform === "win32") {
    const windows = defaultInstallDestination("windows", {
      LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    });
    if (
      windows.toLowerCase() !==
      "c:\\users\\fixture\\appdata\\local\\programs\\acp-mcp\\acp-mcp.exe"
    )
      throw new Error(`Unexpected Windows install destination: ${windows}`);
  }
  if (process.platform === "linux") {
    const linux = defaultInstallDestination("linux", { HOME: "/home/fixture" });
    if (linux !== "/home/fixture/.local/bin/acp-mcp") {
      throw new Error(`Unexpected Linux install destination: ${linux}`);
    }
  }
  const mac = defaultInstallDestination("darwin", { HOME: "/Users/example" });
  if (mac !== "/Users/example/.local/bin/acp-mcp") {
    throw new Error(`Unexpected macOS install destination: ${mac}`);
  }
  let missingHomeRejected = false;
  try {
    defaultInstallDestination("darwin", {});
  } catch (error) {
    missingHomeRejected = String(error).includes("HOME is not set");
  }
  if (!missingHomeRejected) {
    throw new Error("macOS install accepted missing HOME");
  }
});

test("POSIX installer PATH warning checks HOME local bin without edits", () => {
  if (
    !installDirectoryOnPath(
      "/Users/example/.local/bin/acp-mcp",
      "/usr/bin:/Users/example/.local/bin",
      "darwin",
    ) ||
    installDirectoryOnPath(
      "/Users/example/.local/bin/acp-mcp",
      "/usr/bin:/bin",
      "darwin",
    )
  )
    throw new Error("macOS local-bin PATH detection was incorrect");
});

test("release refuses dirty trees and formats stable checksums", () => {
  assertCleanTreeStatus("");
  let rejected = false;
  try {
    assertCleanTreeStatus(" M src/main.ts");
  } catch (error) {
    rejected = String(error).includes("clean working tree");
  }
  const hash = sha256Hex(new TextEncoder().encode("release fixture"));
  if (
    !rejected ||
    checksumText(hash, "acp-mcp-test.exe") !== `${hash}  acp-mcp-test.exe\n`
  )
    throw new Error("Dirty-tree/checksum contract was incorrect");
});

test("runtime dependency license inventory matches the complete npm lock graph", async () => {
  const inventory = parseRuntimeLicenseInventory(
    await nodeFs.readText(
      new URL("../licenses/runtime-dependencies.json", import.meta.url),
    ),
  );
  const lockText = await nodeFs.readText(
    new URL("../package-lock.json", import.meta.url),
  );
  const configText = await nodeFs.readText(
    new URL("../package.json", import.meta.url),
  );
  assertRuntimeLicenseInventoryMatchesLock(lockText, configText, inventory);
  const notices = renderThirdPartyNotices(inventory);
  const checkedInNotices = await nodeFs.readText(
    new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url),
  );
  const normalizeLineEndings = (text: string) => text.replace(/\r\n/g, "\n");
  if (normalizeLineEndings(checkedInNotices) !== normalizeLineEndings(notices))
    throw new Error("Checked-in third-party notices are out of date");
  for (const licensePath of new Set(
    inventory.dependencies.flatMap((entry) => entry.licenseFiles),
  )) {
    await nodeFs.stat(new URL(`../${licensePath}`, import.meta.url));
  }
  for (const expected of [
    "WTFPL",
    "@agentclientprotocol/sdk 1.7.0",
    "@modelcontextprotocol/server 2.3.1",
    "@modelcontextprotocol/core 2.3.1",
    "zod 4.6.5",
  ]) {
    if (!notices.includes(expected)) {
      throw new Error(`Generated notices omitted '${expected}'`);
    }
  }
  if (!notices.includes("Apache-2.0") || !notices.includes("MIT")) {
    throw new Error("Generated notices omitted a runtime dependency license");
  }
  const projectLicense = await nodeFs.readText(
    new URL("../LICENSE", import.meta.url),
  );
  if (!projectLicense.includes("DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE")) {
    throw new Error("The project license was changed or misidentified");
  }
  let driftRejected = false;
  try {
    const driftedLock = JSON.parse(lockText) as {
      packages: Record<string, { version?: string; dev?: boolean }>;
    };
    driftedLock.packages["node_modules/zod"]!.version = "9.9.9";
    assertRuntimeLicenseInventoryMatchesLock(
      JSON.stringify(driftedLock),
      configText,
      inventory,
    );
  } catch {
    driftRejected = true;
  }
  if (!driftRejected) {
    throw new Error("Runtime dependency drift was not rejected");
  }
  let importDriftRejected = false;
  try {
    const driftedPackage = JSON.parse(configText) as {
      dependencies: Record<string, string>;
    };
    driftedPackage.dependencies["new-runtime"] = "1.0.0";
    assertRuntimeLicenseInventoryMatchesLock(
      lockText,
      JSON.stringify(driftedPackage),
      inventory,
    );
  } catch {
    importDriftRejected = true;
  }
  if (!importDriftRejected) {
    throw new Error("Uninventoried npm runtime imports were not rejected");
  }
});

test("release output root rejects a symlink or junction", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-release-root-" });
  const canonicalRoot = await nodeFs.realpath(root);
  const outside = await nodeFs.makeTempDir({
    prefix: "acp-mcp-release-outside-",
  });
  const releases = `${root}${process.platform === "win32" ? "\\" : "/"}dist${
    process.platform === "win32" ? "\\" : "/"
  }releases`;
  try {
    await ensureReleaseOutputRoot(root);
    await ensureReleaseOutputRoot(canonicalRoot);
    await nodeFs.removePath(releases);
    if (process.platform === "win32") {
      const linked = await new ProcessCommand("powershell.exe", {
        args: [
          "-NoProfile",
          "-Command",
          "New-Item -ItemType Junction -Path $env:ACP_RELEASE_LINK -Target $env:ACP_RELEASE_TARGET | Out-Null",
        ],
        env: { ACP_RELEASE_LINK: releases, ACP_RELEASE_TARGET: outside },
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!linked.success) {
        throw new Error("Could not create release-root junction fixture");
      }
    } else {
      await nodeFs.symlink(outside, releases, { type: "dir" });
    }
    let rejected = false;
    try {
      await ensureReleaseOutputRoot(root);
    } catch (error) {
      rejected = String(error).includes("plain directory");
    }
    if (!rejected) {
      throw new Error("A linked release output root was accepted");
    }
    if ((await Array.fromAsync(nodeFs.readDir(outside))).length !== 0) {
      throw new Error("Release root validation touched the external target");
    }
  } finally {
    try {
      await nodeFs.removePath(releases);
    } catch {
      /* link may not have been created */
    }
    await nodeFs.removePath(root, { recursive: true });
    await nodeFs.removePath(outside, { recursive: true });
  }
});

test("install verifies licensed archive before atomically replacing destination", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-local-install-" });
  const releaseDirectory = `${root}${
    process.platform === "win32" ? "\\" : "/"
  }release bundle`;
  const installDirectory = `${root}${
    process.platform === "win32" ? "\\" : "/"
  }installed app`;
  await nodeFs.mkdir(releaseDirectory);
  await nodeFs.mkdir(installDirectory);
  const target = targetId();
  const names = releaseNames(VERSION, target);
  const archive = `${releaseDirectory}${
    process.platform === "win32" ? "\\" : "/"
  }${names.archive}`;
  const destination = `${installDirectory}${
    process.platform === "win32" ? "\\" : "/"
  }acp-mcp${process.platform === "win32" ? ".exe" : ""}`;
  const configPath = `${installDirectory}${
    process.platform === "win32" ? "\\" : "/"
  }config.json`;
  const bytes = new TextEncoder().encode("native executable fixture");
  const hash = sha256Hex(bytes);
  try {
    const fixtureBinary = `${installDirectory}${
      process.platform === "win32" ? "\\" : "/"
    }fixture-native`;
    await nodeFs.writeBytes(fixtureBinary, bytes);
    const manifest = await createReleaseArchive(archive, {
      binaryPath: fixtureBinary,
      version: VERSION,
      target: target as ReleaseTarget,
      commit: "a".repeat(40),
      executableSha256: hash,
    });
    await nodeFs.writeText(
      `${archive}.sha256`,
      checksumText(manifest.archiveSha256, names.archive),
    );
    await nodeFs.writeText(
      `${releaseDirectory}${
        process.platform === "win32" ? "\\" : "/"
      }${names.manifest}`,
      JSON.stringify(manifest),
    );
    await nodeFs.writeText(destination, "previous executable");
    await nodeFs.writeText(configPath, "user config stays unchanged");

    const installed = await installRelease(releaseDirectory, destination, () =>
      Promise.resolve(`acp-mcp ${VERSION}`),
    );
    if (
      installed.hash !== hash ||
      new TextDecoder().decode(await nodeFs.readFile(destination)) !==
        "native executable fixture" ||
      (await nodeFs.readText(configPath)) !== "user config stays unchanged"
    )
      throw new Error("Install did not verify/replace only the executable");

    if (process.platform !== "win32") {
      const mode = (await nodeFs.stat(destination)).mode;
      if (mode === null || (mode & 0o111) === 0) {
        throw new Error("Installed Linux executable is not executable");
      }
    }

    // The installer consumes the same archive/checksum/manifest triplet as a
    // downloaded GitHub Release directory.
    const githubAssetInstall = await installRelease(
      releaseDirectory,
      destination,
      () => Promise.resolve(`acp-mcp ${VERSION}`),
    );
    if (githubAssetInstall.hash !== hash) {
      throw new Error("Installer did not accept the GitHub manifest naming");
    }

    await nodeFs.writeText(destination, "old executable remains");
    await nodeFs.writeBytes(
      archive,
      new TextEncoder().encode("corrupt archive"),
    );
    let rejected = false;
    try {
      await installRelease(releaseDirectory, destination, () =>
        Promise.resolve(`acp-mcp ${VERSION}`),
      );
    } catch (error) {
      rejected = String(error).includes("SHA-256 verification failed");
    }
    if (
      !rejected ||
      (await nodeFs.readText(destination)) !== "old executable remains"
    )
      throw new Error("Corrupt artifact changed the installed executable");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});
