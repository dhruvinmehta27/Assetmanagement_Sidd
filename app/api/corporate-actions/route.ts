import { NextRequest, NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isSupabaseConfigured())
    return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
  const sb = getSupabase();
  const { data, error } = await sb
    .from("corporate_actions")
    .select("*")
    .order("ex_date", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ corporateActions: data });
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

  if (!body.isin || !body.action_type || !body.ex_date || !body.quantity_multiplier) {
    return NextResponse.json(
      { error: "isin, action_type, ex_date and quantity_multiplier are required." },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("corporate_actions")
    .upsert(
      {
        isin: body.isin,
        symbol: body.symbol ?? null,
        security_name: body.security_name ?? null,
        action_type: body.action_type,
        ex_date: body.ex_date,
        quantity_multiplier: Number(body.quantity_multiplier),
        ratio_text: body.ratio_text ?? null,
        notes: body.notes ?? null,
        source: body.source ?? "manual",
      },
      { onConflict: "isin,action_type,ex_date" }
    )
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ saved: true, id: data.id });
}
