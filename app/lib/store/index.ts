import { isSupabaseConfigured } from "@/app/lib/supabase";
import { Store } from "@/app/lib/store/types";

export * from "@/app/lib/store/types";

/**
 * Picks where data is persisted.
 *
 *   desktop -> local SQLite file, nothing leaves the machine
 *   web     -> Supabase
 *
 * The Electron main process sets STORAGE_DRIVER=sqlite explicitly; the
 * DESKTOP_APP fallback covers `npm run desktop:dev`, where the Next server is
 * started by the dev script rather than by Electron. Anything else — Vercel,
 * plain `npm run dev` — gets Supabase, so the hosted app is untouched.
 */
export type DriverName = "sqlite" | "supabase";

export function driverName(): DriverName {
  const explicit = process.env.STORAGE_DRIVER?.trim().toLowerCase();
  if (explicit === "sqlite" || explicit === "supabase") return explicit;
  return process.env.DESKTOP_APP === "1" ? "sqlite" : "supabase";
}

/**
 * The sqlite driver is imported lazily so that `node:sqlite` is never even
 * evaluated on the web, where the runtime may not have it.
 */
export async function getStore(): Promise<Store> {
  if (driverName() === "sqlite") {
    const { sqliteStore } = await import("@/app/lib/store/sqlite");
    return sqliteStore;
  }
  const { supabaseStore } = await import("@/app/lib/store/supabase");
  return supabaseStore;
}

/** False only when the chosen backend still needs configuring. */
export function isStorageConfigured(): boolean {
  // A local database needs nothing configured — the file is created on first use.
  return driverName() === "sqlite" ? true : isSupabaseConfigured();
}

export function storageNotConfiguredMessage(): string {
  return "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment.";
}
