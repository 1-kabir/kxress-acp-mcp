import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
};
export type { Dirent, Stats };

export async function readText(path: string | URL): Promise<string> {
  return await readFile(path, "utf8");
}

export async function writeText(
  path: string | URL,
  text: string,
  options: { append?: boolean } = {},
): Promise<void> {
  await writeFile(path, text, { flag: options.append ? "a" : "w" });
}

export async function writeBytes(
  path: string | URL,
  bytes: Uint8Array,
  options: { create?: boolean; append?: boolean } = {},
): Promise<void> {
  const flag = options.append ? "a" : options.create === false ? "r+" : "w";
  await writeFile(path, bytes, { flag });
}

export async function removePath(
  path: string | URL,
  options: { recursive?: boolean } = {},
): Promise<void> {
  if (options.recursive) {
    await rm(path, { recursive: true });
    return;
  }
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) await rmdir(path);
  else await unlink(path);
}

export async function makeTempDir(
  options: { prefix?: string; dir?: string } = {},
): Promise<string> {
  const parent = options.dir ?? tmpdir();
  return await mkdtemp(join(parent, options.prefix ?? "tmp-"));
}

export async function makeTempFile(
  options: { prefix?: string; suffix?: string; dir?: string } = {},
): Promise<string> {
  const parent = options.dir ?? tmpdir();
  for (;;) {
    const path = join(
      parent,
      `${options.prefix ?? "tmp-"}${randomUUID()}${options.suffix ?? ""}`,
    );
    try {
      const handle = await open(path, "wx");
      await handle.close();
      return path;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
  }
}

export async function* readDir(path: string | URL): AsyncIterable<Dirent> {
  for (const entry of await readdir(path, { withFileTypes: true })) yield entry;
}

export function isErrorCode(
  error: unknown,
  code: string | readonly string[],
): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const errorCode = (error as NodeJS.ErrnoException).code;
  return Array.isArray(code)
    ? code.includes(errorCode ?? "")
    : errorCode === code;
}

export type FileInfo = Stats;
