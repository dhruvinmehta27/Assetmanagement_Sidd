import Anthropic from "@anthropic-ai/sdk";
import { CONTRACT_NOTE_TOOL, ContractNote } from "@/app/lib/schema";

/**
 * PDF -> structured contract note, via Claude.
 *
 * Lives here rather than in the route so the single-file upload and the folder
 * importer share one implementation — otherwise the batch path quietly drifts
 * from the interactive one and they start producing different data.
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

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

export class ExtractionError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "ExtractionError";
    this.status = status;
  }
}

export function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new ExtractionError(
      "ANTHROPIC_API_KEY is not set. Add your Anthropic API key to the app's configuration, then restart the app.",
      500
    );
  }
  return key;
}

export interface ExtractResult {
  data: ContractNote;
  meta: {
    model: string;
    filename: string;
    usage: Anthropic.Usage;
  };
}

/** Send one PDF to Claude and return the structured note. Throws ExtractionError. */
export async function extractContractNote(
  pdf: Buffer,
  filename: string
): Promise<ExtractResult> {
  const client = new Anthropic({ apiKey: getApiKey() });

  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      // Covers thinking *and* the tool output: Sonnet 5 thinks by default, and
      // both draw on this one budget. 8000 truncates notes with many trades.
      max_tokens: 16000,
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
                data: pdf.toString("base64"),
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
  } catch (err: any) {
    const detail =
      err?.error?.error?.message || err?.message || "Unknown error calling Claude API.";
    throw new ExtractionError(`Extraction failed: ${detail}`, err?.status || 500);
  }

  // A decline is a successful HTTP 200 with empty content, not an exception.
  // Without this it surfaces as the misleading "did not return structured data".
  if (message.stop_reason === "refusal") {
    throw new ExtractionError(
      `The model declined to process ${filename}. If this is an ordinary contract note, re-upload it — a decline here is usually a false positive.`,
      502
    );
  }

  // A truncated response still carries a tool_use block, but its input is
  // half-parsed JSON. Silently saving that is worse than failing the note.
  if (message.stop_reason === "max_tokens") {
    throw new ExtractionError(
      `Extraction ran out of output budget on ${filename}. The note is probably long — raise max_tokens and retry.`,
      502
    );
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );

  if (!toolUse) {
    throw new ExtractionError("The model did not return structured data.", 502);
  }

  return {
    data: toolUse.input as ContractNote,
    meta: { model: MODEL, filename, usage: message.usage },
  };
}
