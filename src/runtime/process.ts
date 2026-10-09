import type { AgentDefinition } from "../agents/config.ts";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export async function findExecutablePath(
  command: string,
  pathValue = Deno.env.get("PATH") ?? "",
): Promise<string | undefined> {
  const windows = Deno.build.os === "windows";
  const hasExtension = windows && /\.[^\\/]+$/.test(command);
  const extensions = (Deno.env.get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.toLowerCase() !== ".exe");
  const candidates = windows && !hasExtension
    ? [command + ".exe", ...extensions.map((extension) => command + extension)]
    : [command];
  const hasDirectory = command.includes("\\") || command.includes("/");
  const separator = windows ? ";" : ":";
  const roots = hasDirectory
    ? [""]
    : pathValue.split(separator).filter(Boolean);
  for (const root of roots) {
    for (const candidate of candidates) {
      const full = root
        ? `${root.replace(/[\\/]$/, "")}${windows ? "\\" : "/"}${candidate}`
        : candidate;
      try {
        const info = await Deno.stat(full);
        if (!info.isFile) continue;
        if (
          !windows && info.mode !== null && info.mode !== undefined &&
          (info.mode & 0o111) === 0
        ) continue;
        return full;
      } catch {
        // Search the next PATH candidate.
      }
    }
  }
  return undefined;
}

export async function resolveWindowsExecutable(
  command: string,
): Promise<string> {
  if (Deno.build.os !== "windows") return command;
  const pathExt = (Deno.env.get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const hasExtension = /\.[^\\/]+$/.test(command);
  const candidates = hasExtension ? [command] : [
    command + ".exe",
    ...pathExt.filter((ext) => ext.toLowerCase() !== ".exe").map((ext) =>
      command + ext
    ),
  ];
  const hasDirectory = command.includes("\\") || command.includes("/");
  const roots = hasDirectory
    ? [""]
    : (Deno.env.get("PATH") ?? "").split(";").filter(Boolean);
  for (const root of roots) {
    for (const candidate of candidates) {
      const full = root
        ? `${root.replace(/[\\/]$/, "")}\\${candidate}`
        : candidate;
      if (await isFile(full)) return full;
    }
  }
  return command;
}

export function quoteCmdStaticArgument(value: string): string {
  // Shell operators are inert inside a quoted command argument.
  const escaped = value.replace(/%/g, "%%");
  return `"${escaped.replace(/"/g, '""')}"`;
}

export async function startAgent(definition: AgentDefinition, cwd: string) {
  const resolved = await resolveWindowsExecutable(definition.command);
  const isBatch = Deno.build.os === "windows" && /\.(cmd|bat)$/i.test(resolved);
  const command = isBatch ? (Deno.env.get("COMSPEC") ?? "cmd.exe") : resolved;
  const args = isBatch
    ? ["/d", "/c", "%ACPMCP_CONFIGURED_COMMAND%"]
    : definition.args;
  const env = isBatch
    ? {
      ...definition.env,
      ACPMCP_CONFIGURED_COMMAND: [resolved, ...definition.args].map(
        quoteCmdStaticArgument,
      ).join(" "),
    }
    : definition.env;
  const child = new Deno.Command(command, {
    args,
    cwd,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const tail: string[] = [];
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      tail.push(decoder.decode(chunk));
      while (tail.join("").length > 16_000) tail.shift();
    }
  })();
  return { child, stderrDone, stderrTail: () => tail.join("").slice(-16_000) };
}

export async function stopAgent(
  child: Deno.ChildProcess,
  timeoutMs = 5000,
): Promise<void> {
  try {
    child.stdin.close();
  } catch { /* already closed */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.status.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!exited && Deno.build.os === "windows" && child.pid) {
    try {
      await new Deno.Command("taskkill.exe", {
        args: ["/PID", String(child.pid), "/T", "/F"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
    } catch {
      try {
        child.kill();
      } catch { /* already exited */ }
    }
  } else if (!exited) {
    try {
      child.kill();
    } catch { /* already exited */ }
  }
  if (!exited) await child.status.catch(() => undefined);
}
