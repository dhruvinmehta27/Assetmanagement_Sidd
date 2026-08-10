import { NextRequest, NextResponse } from "next/server";
import { extractContractNote, getApiKey, ExtractionError } from "@/app/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Single contract note upload from the browser. Batch imports use /api/import. */
export async function POST(req: NextRequest) {
  try {
    getApiKey();
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json(
      { error: "Could not read the uploaded form data." },
      { status: 400 }
    );
  }

  if (!file) {
    return NextResponse.json(
      { error: "No file uploaded. Attach a contract note PDF." },
      { status: 400 }
    );
  }
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}. Please upload a PDF.` },
      { status: 400 }
    );
  }

  try {
    const result = await extractContractNote(
      Buffer.from(await file.arrayBuffer()),
      file.name
    );
    return NextResponse.json(result);
  } catch (err: any) {
    const status = err instanceof ExtractionError ? err.status : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
