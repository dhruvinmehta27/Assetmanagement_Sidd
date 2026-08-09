import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { CONTRACT_NOTE_TOOL, ContractNote } from "@/app/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const SYSTEM_PROMPT = `You are a meticulous financial-data extraction engine.
You are given a broker CONTRACT NOTE (trade confirmation) as a PDF.
Extract every field into the provided tool schema.

Rules:
- Extract exactly what the document says. Do NOT guess or fabricate values.
- If a field is genuinely absent, return null for it (do not omit it, do not invent).
- Preserve every individual trade line as a separate item in "trades".
- Numbers must be plain numbers (no currency symbols, no thousands separators).
- For buy/sell, normalise to "BUY" or "SELL".
- Dates: return ISO YYYY-MM-DD when the date is unambiguous; otherwise return the raw string.
- For net_amount: a value the client must PAY is negative with direction "PAYABLE";
  a value the client RECEIVES is positive with direction "RECEIVABLE".
- Use the "notes" field to flag anything ambiguous, unusual, or that you could not parse.
Always call the record_contract_note tool exactly once with your result.`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key, then restart the dev server.",
      },
      { status: 500 }
    );
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

  const bytes = Buffer.from(await file.arrayBuffer());
  const base64 = bytes.toString("base64");

  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: [CONTRACT_NOTE_TOOL as any],
      tool_choice: { type: "tool", name: CONTRACT_NOTE_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: "Extract this contract note into the record_contract_note tool.",
            },
          ],
        },
      ],
    });

    const toolUse = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (!toolUse) {
      return NextResponse.json(
        { error: "The model did not return structured data. Try again." },
        { status: 502 }
      );
    }

    const data = toolUse.input as ContractNote;
    return NextResponse.json({
      data,
      meta: {
        model: MODEL,
        filename: file.name,
        usage: message.usage,
      },
    });
  } catch (err: any) {
    const detail =
      err?.error?.error?.message || err?.message || "Unknown error calling Claude API.";
    const status = err?.status || 500;
    return NextResponse.json(
      { error: `Extraction failed: ${detail}` },
      { status }
    );
  }
}
