export interface RuntimeLicenseEntry {
  name: string;
  version: string;
  license: string;
  source: string;
  licenseFiles: string[];
  attribution: string;
}

export interface RuntimeLicenseInventory {
  projectLicense: "WTFPL";
  dependencies: RuntimeLicenseEntry[];
}

export function parseRuntimeLicenseInventory(
  text: string,
): RuntimeLicenseInventory {
  const value = JSON.parse(text) as RuntimeLicenseInventory;
  if (
    value.projectLicense !== "WTFPL" || !Array.isArray(value.dependencies)
  ) throw new Error("Runtime license inventory must preserve project WTFPL");
  for (const dependency of value.dependencies) {
    if (
      !dependency.name || !dependency.version || !dependency.license ||
      !dependency.source || !dependency.attribution ||
      !Array.isArray(dependency.licenseFiles) ||
      dependency.licenseFiles.length === 0
    ) throw new Error("Runtime license inventory entry is incomplete");
  }
  return value;
}

function npmPackageVersion(lockKey: string): { name: string; version: string } {
  const match = lockKey.match(/^(@[^/]+\/[^@]+|[^@]+)@([^_]+)(?:_.*)?$/);
  if (!match) throw new Error(`Unsupported npm lock entry '${lockKey}'`);
  return { name: match[1], version: match[2] };
}

export function assertRuntimeLicenseInventoryMatchesLock(
  lockText: string,
  denoConfigText: string,
  inventory: RuntimeLicenseInventory,
): void {
  const lock = JSON.parse(lockText) as {
    npm?: Record<string, unknown>;
  };
  const locked = Object.keys(lock.npm ?? {}).map(npmPackageVersion);
  const inventoried = inventory.dependencies.map(({ name, version }) => ({
    name,
    version,
  }));
  const key = ({ name, version }: { name: string; version: string }) =>
    `${name}@${version}`;
  const lockedKeys = locked.map(key).sort();
  const inventoryKeys = inventoried.map(key).sort();
  const config = JSON.parse(denoConfigText) as {
    imports?: Record<string, string>;
  };
  const configured = new Set<string>();
  for (const specifier of Object.values(config.imports ?? {})) {
    if (!specifier.startsWith("npm:")) continue;
    const match = specifier.match(
      /^npm:(@[^/]+\/[^@/]+|[^@/]+)@([^/]+)(?:\/.*)?$/,
    );
    if (!match) {
      throw new Error(`Unsupported npm runtime import '${specifier}'`);
    }
    configured.add(`${match[1]}@${match[2]}`);
  }
  const inventoriedNames = new Set(inventoryKeys);
  const missingConfigured = [...configured].filter((entry) =>
    !inventoriedNames.has(entry)
  );
  if (missingConfigured.length) {
    throw new Error(
      `Runtime imports are missing from license inventory: ${
        missingConfigured.join(", ")
      }`,
    );
  }
  if (lockedKeys.join("\n") !== inventoryKeys.join("\n")) {
    throw new Error(
      `Runtime license inventory does not match deno.lock npm graph. Locked: ${
        lockedKeys.join(", ")
      }; inventoried: ${inventoryKeys.join(", ")}`,
    );
  }
}

export function renderThirdPartyNotices(
  inventory: RuntimeLicenseInventory,
): string {
  const lines = [
    "acp-mcp includes the runtime dependencies listed below in its native release binaries.",
    "",
    "The original acp-mcp source is licensed under WTFPL; this does not change the",
    "separate licenses of third-party code included in the binaries.",
    "",
  ];
  for (const dependency of inventory.dependencies) {
    lines.push(
      `${dependency.name} ${dependency.version}`,
      `  License: ${dependency.license}`,
      `  Source: ${dependency.source}`,
      `  ${dependency.attribution}`,
      `  License text: ${dependency.licenseFiles.join(" and ")}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
