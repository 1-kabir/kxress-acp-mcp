import {
  artifactName,
  assertCleanTreeStatus,
  checksumText,
  ensureReleaseOutputRoot,
  installRelease,
  sha256Hex,
  targetId,
} from "../scripts/release.ts";
import { VERSION } from "../src/version.ts";

Deno.test("release target and artifact names encode native platform/version", () => {
  if (
    targetId("windows", "x86_64") !== "windows-x86_64" ||
    artifactName("0.2.0", "windows-x86_64", "windows") !==
      "acp-mcp-0.2.0-windows-x86_64.exe" ||
    artifactName("0.2.0", "linux-x86_64", "linux") !==
      "acp-mcp-0.2.0-linux-x86_64"
  ) throw new Error("Release naming did not match the native target");
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

Deno.test("release output root rejects a symlink or junction", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-release-root-" });
  const outside = await Deno.makeTempDir({
    prefix: "acp-mcp-release-outside-",
  });
  const releases = `${root}${Deno.build.os === "windows" ? "\\" : "/"}dist${
    Deno.build.os === "windows" ? "\\" : "/"
  }releases`;
  try {
    await ensureReleaseOutputRoot(root);
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

Deno.test("install verifies artifact bytes before atomically replacing destination", async () => {
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
  const filename = artifactName(VERSION, target);
  const artifact = `${releaseDirectory}${
    Deno.build.os === "windows" ? "\\" : "/"
  }${filename}`;
  const destination = `${installDirectory}${
    Deno.build.os === "windows" ? "\\" : "/"
  }acp-mcp${Deno.build.os === "windows" ? ".exe" : ""}`;
  const configPath = `${installDirectory}${
    Deno.build.os === "windows" ? "\\" : "/"
  }config.json`;
  const bytes = new TextEncoder().encode("native executable fixture");
  const hash = sha256Hex(bytes);
  try {
    await Deno.writeFile(artifact, bytes);
    await Deno.writeTextFile(
      `${releaseDirectory}${
        Deno.build.os === "windows" ? "\\" : "/"
      }manifest.json`,
      JSON.stringify({
        product: "acp-mcp",
        version: VERSION,
        target,
        commit: "a".repeat(40),
        sha256: hash,
      }),
    );
    await Deno.writeTextFile(
      `${artifact}.sha256`,
      checksumText(hash, filename),
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

    await Deno.writeTextFile(destination, "old executable remains");
    await Deno.writeFile(
      artifact,
      new TextEncoder().encode("corrupt artifact"),
    );
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
