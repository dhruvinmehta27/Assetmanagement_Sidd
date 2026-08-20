import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  try {
    const store = await getStore();
    return NextResponse.json({ dividends: await store.listDividends() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.isin) {
    return NextResponse.json({ error: "ISIN is required." }, { status: 400 });
  }

  const store = await getStore();
  if (store.accountsSupported && !body.account_id) {
    return NextResponse.json(
      { error: "Choose which account received this dividend." },
      { status: 400 }
    );
  }

  const gross =
    body.gross_amount ??
    (body.amount_per_share && body.quantity
      ? Number(body.amount_per_share) * Number(body.quantity)
      : null);
  const tds = body.tds ?? 0;
  const net = body.net_amount ?? (gross != null ? gross - tds : null);

  try {
    const id = await store.addDividend({
      isin: body.isin,
      // Without this the row saves with no owner and is excluded from every
      // portfolio view — silently, which is the worst way to lose a number.
      account_id: body.account_id ?? null,
      symbol: body.symbol ?? null,
      security_name: body.security_name ?? null,
      ex_date: body.ex_date || null,
      pay_date: body.pay_date || null,
      amount_per_share: body.amount_per_share ?? null,
      quantity: body.quantity ?? null,
      gross_amount: gross,
      tds,
      net_amount: net,
      source: body.source ?? "manual",
      notes: body.notes ?? null,
    });
    return NextResponse.json({ saved: true, id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
