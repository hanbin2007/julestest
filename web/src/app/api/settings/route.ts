import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 偏好(rate/density) + last-watched，存为 Setting(key->JSON)。跨设备共享。
const DEFAULT_PREFS = { rate: 1, density: "comfortable" as const };

async function readKey<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function writeKey(key: string, value: unknown) {
  const v = JSON.stringify(value);
  await prisma.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

export async function GET() {
  const [prefs, last] = await Promise.all([
    readKey("prefs", DEFAULT_PREFS),
    readKey<unknown | null>("last", null),
  ]);
  return Response.json({ prefs: { ...DEFAULT_PREFS, ...(prefs as object) }, last });
}

export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  if (d.prefs && typeof d.prefs === "object") {
    const cur = await readKey("prefs", DEFAULT_PREFS);
    await writeKey("prefs", { ...cur, ...d.prefs });
  }
  if (d.last !== undefined) {
    await writeKey("last", d.last);
  }
  return Response.json({ ok: true });
}
