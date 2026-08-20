import { NextRequest, NextResponse } from "next/server";
import { getStore, isStorageConfigured, storageNotConfiguredMessage } from "@/app/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete a contract note and the trades under it.
 *
 * Until now nothing in the app could be undone: a note read wrongly, or imported
 * twice under a different number, stayed for good and quietly moved every figure
 * that depended on it. This is the way back.
 *
 * Deliberately a delete rather than an edit. The note is a transcription of a
 * document — if the transcription is wrong the honest fix is to remove it and
 * read the document again, not to hand-adjust figures until they look right and
 * leave no trace that they were adjusted.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "An id is required." }, { status: 400 });

  try {
    const store = await getStore();
    const deleted = await store.deleteContractNote(id);
    if (!deleted) {
      return NextResponse.json({ error: "That note no longer exists." }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
