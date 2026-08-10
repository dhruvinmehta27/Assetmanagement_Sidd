import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { assertDesktop, ensureStructure, scanInbox, NotDesktopError } from "@/app/lib/folder";

export const runtime = "nodejs";

/**
 * Pre-flight for a folder import: create the folder structure if needed and
 * report what is waiting in inbox/. Runs before anything is billed, so the user
 * sees the file count and can back out.
 */
export async function POST(req: NextRequest) {
  try {
    assertDesktop();
  } catch (err) {
    const status = err instanceof NotDesktopError ? 403 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }

  let root: string;
  try {
    ({ root } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!root || typeof root !== "string") {
    return NextResponse.json({ error: "No folder selected." }, { status: 400 });
  }

  try {
    await ensureStructure(root);
    const files = await scanInbox(root);
    return NextResponse.json({
      root,
      count: files.length,
      files: files.map((f) => path.basename(f)),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
