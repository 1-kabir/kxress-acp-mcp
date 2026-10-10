import { basename, dirname, resolve } from "node:path";
import {
  ANTIGRAVITY_AGY_ACP_RELEASE,
  antigravityAgyAcpInstallPath,
} from "../src/agents/config.ts";

function parseDestinationDirectory(args: string[]): string | undefined {
  let destination: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--destination-dir" || destination !== undefined) {
      throw new Error(
        "Usage: provision_antigravity_agy.ts [--destination-dir <path>]",
      );
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error("--destination-dir requires a path");
    }
    destination = resolve(value);
  }
  return destination;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function existingHash(path: string): Promise<string | undefined> {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isFile) {
      throw new Error(`Refusing non-regular adapter destination: ${path}`);
    }
    return await sha256(await Deno.readFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function provision(): Promise<void> {
  if (Deno.build.os !== "windows" || Deno.build.arch !== "x86_64") {
    throw new Error(
      "The pinned Antigravity agy adapter is provisioned for Windows x86_64 only",
    );
  }
  const destinationDirectory = parseDestinationDirectory(Deno.args) ??
    dirname(antigravityAgyAcpInstallPath());
  const destination = resolve(
    destinationDirectory,
    basename(ANTIGRAVITY_AGY_ACP_RELEASE.asset),
  );

  const currentHash = await existingHash(destination);
  if (currentHash) {
    if (currentHash !== ANTIGRAVITY_AGY_ACP_RELEASE.sha256) {
      throw new Error(
        `Existing adapter differs from the pinned release; refusing to overwrite: ${destination}`,
      );
    }
    console.log(
      `Antigravity agy ACP ${ANTIGRAVITY_AGY_ACP_RELEASE.version} already provisioned (${currentHash}) at ${destination}`,
    );
    return;
  }

  await Deno.mkdir(destinationDirectory, { recursive: true });
  const response = await fetch(ANTIGRAVITY_AGY_ACP_RELEASE.url);
  if (!response.ok) {
    throw new Error(
      `Could not download the pinned adapter release (HTTP ${response.status})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const downloadedHash = await sha256(bytes);
  if (downloadedHash !== ANTIGRAVITY_AGY_ACP_RELEASE.sha256) {
    throw new Error(
      `Pinned adapter SHA-256 mismatch; expected ${ANTIGRAVITY_AGY_ACP_RELEASE.sha256}, got ${downloadedHash}`,
    );
  }

  const staging = await Deno.makeTempFile({
    dir: destinationDirectory,
    prefix: ".agy-acp-",
    suffix: ".stage",
  });
  try {
    await Deno.writeFile(staging, bytes, { create: false, append: false });
    if (await sha256(await Deno.readFile(staging)) !== downloadedHash) {
      throw new Error("Staged adapter bytes failed SHA-256 verification");
    }
    try {
      await Deno.link(staging, destination);
    } catch (error) {
      const racedHash = await existingHash(destination);
      if (racedHash !== downloadedHash) throw error;
    }
  } finally {
    try {
      await Deno.remove(staging);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(`Could not remove adapter staging file: ${staging}`);
      }
    }
  }

  const installedHash = await existingHash(destination);
  if (installedHash !== downloadedHash) {
    throw new Error(
      "Provisioned adapter failed destination SHA-256 verification",
    );
  }
  console.log(
    `Provisioned Antigravity agy ACP ${ANTIGRAVITY_AGY_ACP_RELEASE.version} (${ANTIGRAVITY_AGY_ACP_RELEASE.target}, source ${ANTIGRAVITY_AGY_ACP_RELEASE.revision})\nPath: ${destination}\nSHA-256: ${installedHash}`,
  );
}

if (import.meta.main) {
  try {
    await provision();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Antigravity agy ACP provisioning failed",
    );
    Deno.exitCode = 1;
  }
}
