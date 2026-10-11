export const RELEASE_TARGETS = [
  "windows-x86_64",
  "linux-x86_64",
  "macos-arm64",
] as const;

export type ReleaseTarget = typeof RELEASE_TARGETS[number];

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(value);
}

export function isWindowsTarget(target: string): target is "windows-x86_64" {
  return target === "windows-x86_64";
}

export function targetId(
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): ReleaseTarget {
  if (os === "windows" && arch === "x86_64") return "windows-x86_64";
  if (os === "linux" && arch === "x86_64") return "linux-x86_64";
  if (os === "darwin" && arch === "aarch64") return "macos-arm64";
  throw new Error(
    `Unsupported native release platform '${os}-${arch}'; supported targets are ${
      RELEASE_TARGETS.join(", ")
    }`,
  );
}
