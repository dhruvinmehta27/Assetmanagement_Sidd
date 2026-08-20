import { NextRequest, NextResponse } from "next/server";
import { getStore, isStorageConfigured, storageNotConfiguredMessage } from "@/app/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rename an account, correct its PAN, or delete it.
 *
 * A wrong PAN is worth correcting rather than working around: it is what routes
 * notes to a person, so fixing it also claims every note that was waiting for
 * the right one.
 *
 * Deleting withdraws the claim and nothing else — the notes and trades go back
 * to the unassigned queue rather than being destroyed. They came from real
 * documents and deleting an account is a statement about the account, not about
 * them.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  try {
    const store = await getStore();
    await store.updateAccount(id, {
      label: String(body.label ?? "").trim(),
      pan: body.pan ? String(body.pan).trim() : null,
      entity_type: body.entity_type,
    });
    return NextResponse.json({ updated: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const { id } = await params;
  try {
    const store = await getStore();
    const deleted = await store.deleteAccount(id);
    if (!deleted) {
      return NextResponse.json({ error: "That account no longer exists." }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
