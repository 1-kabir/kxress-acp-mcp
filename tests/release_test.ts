import {
  artifactName,
  assertCleanTreeStatus,
  checksumText,
  defaultInstallDestination,
  ensureReleaseOutputRoot,
  installRelease,
  sha256Hex,
  targetId,
} from "../scripts/release.ts";
import { VERSION } from "../src/version.ts";
import {
  createReleaseArchive,
  releaseNames,
} from "../scripts/release_package.ts";
import {
  assertRuntimeLicenseInventoryMatchesLock,
  parseRuntimeLicenseInventory,
  renderThirdPartyNotices,
} from "../scripts/license_inventory.ts";

Deno.test("release target and artifact names encode native platform/version", () => {
  if (
    targetId("windows", "x86_64") !== "windows-x86_64" ||
    artifactName("0.2.0", "windows-x86_64", "windows") !==
      "acp-mcp-0.2.0-windows-x86_64.zip" ||
    artifactName("0.2.0", "linux-x86_64", "linux") !==
      "acp-mcp-0.2.0-linux-x86_64.tar.gz"
  ) throw new Error("Release naming did not match the native target");
  let unsupportedRejected = false;
  try {
    targetId("darwin", "x86_64");
  } catch (error) {
    unsupportedRejected = String(error).includes("supported targets");
  }
  if (!unsupportedRejected) {
    throw new Error("An unsupported native target was accepted");
  }
});

Deno.test("default install locations are user-local on both native targets", () => {
  if (Deno.build.os === "windows") {
    const windows = defaultInstallDestination("windows", {
      LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    });
    if (
      windows.toLowerCase() !==
        "c:\\users\\fixture\\appdata\\local\\programs\\acp-mcp\\acp-mcp.exe"
    ) throw new Error(`Unexpected Windows install destination: ${windows}`);
  }
  if (Deno.build.os === "linux") {
    const linux = defaultInstallDestination("linux", { HOME: "/home/fixture" });
    if (linux !== "/home/fixture/.local/bin/acp-mcp") {
      throw new Error(`Unexpected Linux install destination: ${linux}`);
    }
  }
});

Deno.test("release refuses dirty trees and formats stable checksums", () => {
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
    checksumText(hash, "acp-mcp-test.exe") !==
      `${hash}  acp-mcp-test.exe\n`
  ) throw new Error("Dirty-tree/checksum contract was incorrect");
});

Deno.test("runtime dependency license inventory matches the complete lock graph", async () => {
  const inventory = parseRuntimeLicenseInventory(
    await Deno.readTextFile(
      new URL("../licenses/runtime-dependencies.json", import.meta.url),
    ),
  );
  const lockText = await Deno.readTextFile(
    new URL("../deno.lock", import.meta.url),
  );
  const configText = await Deno.readTextFile(
    new URL("../deno.jsonc", import.meta.url),
  );
  assertRuntimeLicenseInventoryMatchesLock(lockText, configText, inventory);
  const notices = renderThirdPartyNotices(inventory);
  const checkedInNotices = await Deno.readTextFile(
    new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url),
  );
  const normalizeLineEndings = (text: string) => text.replace(/\r\n/g, "\n");
  if (
    normalizeLineEndings(checkedInNotices) !== normalizeLineEndings(notices)
  ) throw new Error("Checked-in third-party notices are out of date");
  for (
    const licensePath of new Set(
      inventory.dependencies.flatMap((entry) => entry.licenseFiles),
    )
  ) {
    await Deno.stat(new URL(`../${licensePath}`, import.meta.url));
  }
  for (
    const expected of [
      "WTFPL",
      "@agentclientprotocol/sdk 1.7.0",
      "@modelcontextprotocol/server 2.3.1",
      "@modelcontextprotocol/core 2.3.1",
      "zod 4.6.5",
    ]
  ) {
    if (!notices.includes(expected)) {
      throw new Error(`Generated notices omitted '${expected}'`);
    }
  }
  if (!notices.includes("Apache-2.0") || !notices.includes("MIT")) {
    throw new Error("Generated notices omitted a runtime dependency license");
  }
  const projectLicense = await Deno.readTextFile(
    new URL("../LICENSE", import.meta.url),
  );
  if (!projectLicense.includes("DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE")) {
    throw new Error("The project license was changed or misidentified");
  }
  let driftRejected = false;
  try {
    assertRuntimeLicenseInventoryMatchesLock(
      lockText.replace('"zod@4.6.5"', '"new-runtime@1.0.0"'),
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
    assertRuntimeLicenseInventoryMatchesLock(
      lockText,
      configText.replace(
        '"zod": "npm:zod@4.6.5"',
        '"new-runtime": "npm:new-runtime@1.0.0"',
      ),
      inventory,
    );
  } catch {
    importDriftRejected = true;
  }
  if (!importDriftRejected) {
    throw new Error("Uninventoried npm runtime imports were not rejected");
  }
});

Deno.test("release output root rejects a symlink or junction", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-release-root-" });
  const canonicalRoot = await Deno.realPath(root);
  const outside = await Deno.makeTempDir({
    prefix: "acp-mcp-release-outside-",
  });
  const releases = `${root}${Deno.build.os === "windows" ? "\\" : "/"}dist${
    Deno.build.os === "windows" ? "\\" : "/"
  }releases`;
  try {
    await ensureReleaseOutputRoot(root);
    await ensureReleaseOutputRoot(canonicalRoot);
    await Deno.remove(releases);
    if (Deno.build.os === "windows") {
      const linked = await new Deno.Command("powershell.exe", {
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
      await Deno.symlink(outside, releases, { type: "dir" });
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
    if ((await Array.fromAsync(Deno.readDir(outside))).length !== 0) {
      throw new Error("Release root validation touched the external target");
    }
  } finally {
    try {
      await Deno.remove(releases);
    } catch { /* link may not have been created */ }
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("install verifies licensed archive before atomically replacing destination", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-local-install-" });
  const releaseDirectory = `${root}${
    Deno.build.os === "windows" ? "\\" : "/"
  }release bundle`;
  const installDirectory = `${root}${
    Deno.build.os === "windows" ? "\\" : "/"
  }installed app`;
  await Deno.mkdir(releaseDirectory);
  await Deno.mkdir(installDirectory);
  const target = targetId();
  const names = releaseNames(VERSION, target);
  const archive = `${releaseDirectory}${
    Deno.build.os === "windows" ? "\\" : "/"
  }${names.archive}`;
  const destination = `${installDirectory}${
    Deno.build.os === "windows" ? "\\" : "/"
  }acp-mcp${Deno.build.os === "windows" ? ".exe" : ""}`;
  const configPath = `${installDirectory}${
    Deno.build.os === "windows" ? "\\" : "/"
  }config.json`;
  const bytes = new TextEncoder().encode("native executable fixture");
  const hash = sha256Hex(bytes);
  try {
    const fixtureBinary = `${installDirectory}${
      Deno.build.os === "windows" ? "\\" : "/"
    }fixture-native`;
    await Deno.writeFile(fixtureBinary, bytes);
    const manifest = await createReleaseArchive(archive, {
      binaryPath: fixtureBinary,
      version: VERSION,
      target: target as "windows-x86_64" | "linux-x86_64",
      commit: "a".repeat(40),
      executableSha256: hash,
    });
    await Deno.writeTextFile(
      `${archive}.sha256`,
      checksumText(manifest.archiveSha256, names.archive),
    );
    await Deno.writeTextFile(
      `${releaseDirectory}${
        Deno.build.os === "windows" ? "\\" : "/"
      }${names.manifest}`,
      JSON.stringify(manifest),
    );
    await Deno.writeTextFile(destination, "previous executable");
    await Deno.writeTextFile(configPath, "user config stays unchanged");

    const installed = await installRelease(
      releaseDirectory,
      destination,
      () => Promise.resolve(`acp-mcp ${VERSION}`),
    );
    if (
      installed.hash !== hash ||
      new TextDecoder().decode(await Deno.readFile(destination)) !==
        "native executable fixture" ||
      await Deno.readTextFile(configPath) !== "user config stays unchanged"
    ) throw new Error("Install did not verify/replace only the executable");

    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(destination)).mode;
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

    await Deno.writeTextFile(destination, "old executable remains");
    await Deno.writeFile(archive, new TextEncoder().encode("corrupt archive"));
    let rejected = false;
    try {
      await installRelease(
        releaseDirectory,
        destination,
        () => Promise.resolve(`acp-mcp ${VERSION}`),
      );
    } catch (error) {
      rejected = String(error).includes("SHA-256 verification failed");
    }
    if (
      !rejected ||
      await Deno.readTextFile(destination) !== "old executable remains"
    ) throw new Error("Corrupt artifact changed the installed executable");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
