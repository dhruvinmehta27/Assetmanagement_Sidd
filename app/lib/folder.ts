import fs from "node:fs/promises";
import path from "node:path";
import { ContractNote } from "@/app/lib/schema";

/**
 * Filesystem side of the folder importer.
 *
 * DESKTOP ONLY. These helpers take a filesystem path supplied by the client and
 * read/move files under it. That is fine inside the Electron app, where the
 * server and the user are the same person on the same machine, but it would be
 * an arbitrary-path-traversal hole on a hosted deploy — hence `assertDesktop()`,
 * which every route touching this module must call first.
 */

export const INBOX = "inbox";
export const IMPORTED = "imported";
export const FAILED = "failed";

export function isDesktop(): boolean {
  return process.env.DESKTOP_APP === "1";
}

export class NotDesktopError extends Error {
  constructor() {
    super("Folder import is only available in the desktop app.");
    this.name = "NotDesktopError";
  }
}

export function assertDesktop(): void {
  if (!isDesktop()) throw new NotDesktopError();
}

/** Create inbox/ imported/ failed/ under `root` if they are not already there. */
export async function ensureStructure(root: string): Promise<void> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a folder: ${root}`);
  }
  for (const dir of [INBOX, IMPORTED, FAILED]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
}

/** Every *.pdf under inbox/, at any depth. Sorted for a stable processing order. */
export async function scanInbox(root: string): Promise<string[]> {
  const inbox = path.join(root, INBOX);
  const found: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        // Skip macOS resource forks and other dotfiles.
        if (!entry.name.startsWith(".")) found.push(full);
      }
    }
  }

  await walk(inbox);
  return found.sort();
}

/**
 * Indian financial year label for an ISO date: 1 Apr - 31 Mar.
 *   2024-08-01 -> "2024-25"      2025-02-01 -> "2024-25"
 * Mirrors fin_year() in supabase/schema.sql.
 */
export function finYear(isoDate: string | null | undefined): string {
  if (!isoDate) return "unknown-date";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return "unknown-date";

  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Make a string safe to use as a single path segment. */
export function safeSegment(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "")
    .replace(/[/\\:*?"<>|]/g, "-") // characters no filesystem should carry
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  // "." and ".." survive the character filter but still traverse when joined.
  // This value comes out of a PDF via the model, so it is not trustworthy input.
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/** Append " (2)", " (3)" … until the path is free, so a move never overwrites. */
async function uniquePath(target: string): Promise<string> {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);

  let candidate = target;
  let n = 2;
  while (true) {
    const exists = await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
}

/** rename(), falling back to copy+unlink when src and dest are on different volumes. */
async function move(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

/**
 * File a processed PDF under imported/<broker>/<financial-year>/.
 *
 * The destination comes from the *extracted* note rather than the filename, so
 * a note called "download (3).pdf" still lands in the right place.
 */
export async function fileAsImported(
  root: string,
  src: string,
  note: ContractNote
): Promise<string> {
  const broker = safeSegment(note.broker_name, "Unknown Broker");
  const year = finYear(note.trade_date);
  const dest = await uniquePath(
    path.join(root, IMPORTED, broker, year, path.basename(src))
  );
  await move(src, dest);
  return dest;
}

/** Move a PDF to failed/ and drop a sibling .error.txt explaining why. */
export async function fileAsFailed(
  root: string,
  src: string,
  reason: string
): Promise<string> {
  const dest = await uniquePath(path.join(root, FAILED, path.basename(src)));
  await move(src, dest);

  const stamp = new Date().toISOString();
  await fs
    .writeFile(
      `${dest}.error.txt`,
      `Import failed\nFile:  ${path.basename(src)}\nWhen:  ${stamp}\n\n${reason}\n`,
      "utf8"
    )
    .catch(() => {
      // The PDF is safely in failed/ either way; losing the note is not worth
      // failing the whole batch over.
    });

  return dest;
}
