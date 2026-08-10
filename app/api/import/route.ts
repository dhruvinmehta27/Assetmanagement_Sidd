import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { extractContractNote } from "@/app/lib/extract";
import { saveContractNote } from "@/app/lib/persist";
import { isSupabaseConfigured } from "@/app/lib/supabase";
import {
  assertDesktop,
  ensureStructure,
  scanInbox,
  fileAsImported,
  fileAsFailed,
  NotDesktopError,
} from "@/app/lib/folder";

export const runtime = "nodejs";
// Long batches must not be cut off mid-flight; the desktop server has no
// platform timeout, unlike Vercel.
export const maxDuration = 3600;

/**
 * Batch-import every PDF under <root>/inbox.
 *
 * Streams newline-delimited JSON so the UI can show real progress: a batch of
 * 200 notes is 200 Claude calls and several minutes, which is far too long to
 * leave a user staring at a spinner with no idea what it is costing them.
 *
 * Each file ends in exactly one of three states, and is moved accordingly:
 *   saved     -> imported/<broker>/<financial-year>/
 *   duplicate -> imported/... (already in the DB; still filed, never re-saved)
 *   failed    -> failed/ with a sibling .error.txt
 */

/** How many PDFs are in flight at once. Kept low to stay clear of rate limits. */
const CONCURRENCY = 3;

type Event = Record<string, unknown>;

export async function POST(req: NextRequest) {
  try {
    assertDesktop();
  } catch (err) {
    const status = err instanceof NotDesktopError ? 403 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Supabase is not configured. Add your Supabase settings, then restart the app." },
      { status: 500 }
    );
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

  let files: string[];
  try {
    await ensureStructure(root);
    files = await scanInbox(root);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: Event) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      const counts = { saved: 0, duplicate: 0, failed: 0 };
      let nextIndex = 0;
      let processed = 0;

      send({ type: "start", total: files.length, root });

      /** One worker pulls files off the shared cursor until they run out. */
      const worker = async () => {
        while (true) {
          // Stopping the batch is a money decision, so honour an aborted
          // request immediately rather than draining the queue first.
          if (req.signal.aborted) return;

          const index = nextIndex++;
          if (index >= files.length) return;

          const file = files[index];
          const name = path.basename(file);
          send({ type: "file", index, name, status: "processing" });

          try {
            const pdf = await fs.readFile(file);
            const { data } = await extractContractNote(pdf, name);
            const result = await saveContractNote(data, name);

            const dest = await fileAsImported(root, file, data);
            const status = result.duplicate ? "duplicate" : "saved";
            counts[status] += 1;

            send({
              type: "result",
              index,
              name,
              status,
              broker: data.broker_name,
              trade_date: data.trade_date,
              contract_note_number: data.contract_note_number,
              trades: result.trades,
              movedTo: path.relative(root, dest),
            });
          } catch (err: any) {
            const reason = err?.message || String(err);
            counts.failed += 1;

            let movedTo: string | null = null;
            try {
              movedTo = path.relative(root, await fileAsFailed(root, file, reason));
            } catch {
              // Could not move it — leave it in inbox/ and say so, rather than
              // reporting a tidy failure that did not actually happen.
            }

            send({ type: "result", index, name, status: "failed", error: reason, movedTo });
          } finally {
            processed += 1;
            send({ type: "progress", processed, total: files.length });
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker)
      );

      send({
        type: "done",
        ...counts,
        total: files.length,
        processed,
        aborted: req.signal.aborted,
        elapsedMs: Date.now() - started,
      });

      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Progress is useless if a proxy buffers it into one lump at the end.
      "X-Accel-Buffering": "no",
    },
  });
}
