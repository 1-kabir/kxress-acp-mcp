import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import {
  checksumText,
  loadLicenseInventory,
  renderThirdPartyNotices,
  sha256File,
} from "./release_package.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = join(root, "dist", "acp-mcp.mjs");
const name = `acp-mcp-${VERSION}-node.zip`;
const checksumName = `${name}.sha256`;
const manifestName = `acp-mcp-${VERSION}-node.manifest.json`;
const files = [
  "acp-mcp.mjs",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "licenses/Apache-2.0.txt",
  "licenses/MCP-SDK-MIT.txt",
  "licenses/Zod-MIT.txt",
];

async function create(): Promise<void> {
  const inventory = await loadLicenseInventory(root);
  const stage = await nodeFs.makeTempDir({ prefix: "acp-mcp-node-package-" });
  const output = join(root, "dist", "node-package");
  try {
    await nodeFs.mkdir(join(stage, "licenses"), { recursive: true });
    await nodeFs.copyFile(bundle, join(stage, "acp-mcp.mjs"));
    await nodeFs.copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
    await nodeFs.writeText(
      join(stage, "THIRD_PARTY_NOTICES.txt"),
      renderThirdPartyNotices(inventory),
    );
    for (const relative of new Set(
      inventory.dependencies.flatMap((item) => item.licenseFiles),
    )) {
      await nodeFs.copyFile(join(root, relative), join(stage, relative));
    }
    const manifest = {
      product: "acp-mcp",
      version: VERSION,
      runtime: "node >=24.12.0",
      entry: "acp-mcp.mjs",
      entrySha256: await sha256File(join(stage, "acp-mcp.mjs")),
    };
    await nodeFs.writeText(
      join(stage, "node-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await nodeFs.removePath(output, { recursive: true }).catch(() => undefined);
    await nodeFs.mkdir(output, { recursive: true });
    const archive = join(output, name);
    const zip = await new ProcessCommand("zip", {
      args: ["-q", "-r", archive, ...files, "node-manifest.json"],
      cwd: stage,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (!zip.success)
      throw new Error("Could not create Node release ZIP (zip command failed)");
    const archiveSha256 = await sha256File(archive);
    await nodeFs.writeText(
      join(output, checksumName),
      checksumText(archiveSha256, name),
    );
    await nodeFs.writeText(
      join(output, manifestName),
      `${JSON.stringify({ ...manifest, archive: name, archiveSha256 }, null, 2)}\n`,
    );
    console.log(`Created ${archive}`);
  } finally {
    await nodeFs.removePath(stage, { recursive: true });
  }
}

async function stage(): Promise<void> {
  const source = join(root, "dist", "node-package");
  const destination = join(root, "dist", "github-release-assets");
  const names = [name, checksumName, manifestName];
  await nodeFs.mkdir(destination, { recursive: true });
  for (const filename of names)
    await nodeFs.copyFile(join(source, filename), join(destination, filename));
  console.log(`Staged ${names.map(basename).join(", ")}`);
}

const command = process.argv[2] ?? "create";
if (command === "create") await create();
else if (command === "stage") await stage();
else throw new Error("Usage: node scripts/node_archive.ts [create|stage]");
