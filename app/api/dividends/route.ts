import { NextRequest, NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isSupabaseConfigured())
    return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
  const sb = getSupabase();
  const { data, error } = await sb
    .from("dividends")
    .select("*")
    .order("pay_date", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dividends: data });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured())
    return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.isin) {
    return NextResponse.json({ error: "ISIN is required." }, { status: 400 });
  }

  const gross =
    body.gross_amount ??
    (body.amount_per_share && body.quantity
      ? Number(body.amount_per_share) * Number(body.quantity)
      : null);
  const tds = body.tds ?? 0;
  const net = body.net_amount ?? (gross != null ? gross - tds : null);

  const sb = getSupabase();
  const { data, error } = await sb
    .from("dividends")
    .insert({
      isin: body.isin,
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
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ saved: true, id: data.id });
}
