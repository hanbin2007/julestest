import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { SYSTEM_PROMPT_MAX } from "@/lib/chatPrefs";

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

// prefs 读-改-写串行锁：防止并发 POST 互相覆盖（lost update）。
// fn 在上一次 settle（成功或失败）后执行，链本身永不携带拒绝态。
let prefsLock: Promise<unknown> = Promise.resolve();
function withPrefsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = prefsLock.then(fn, fn); // 上一次无论成败都继续
  prefsLock = run.catch(() => {}); // 保持链可用，不泄漏拒绝
  return run;
}

export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  if (d.prefs && typeof d.prefs === "object") {
    const patch = d.prefs as Record<string, unknown>;
    // 校验在锁外，不涉及共享状态，可提前返回。
    if (typeof patch.systemPrompt === "string" && patch.systemPrompt.length > SYSTEM_PROMPT_MAX) {
      return Response.json({ error: `系统提示词过长（上限 ${SYSTEM_PROMPT_MAX} 字符）` }, { status: 400 });
    }
    // 读-改-写（含 systemPrompt 对比）在锁内串行，确保并发请求不丢更新。
    await withPrefsLock(async () => {
      const cur = (await readKey("prefs", DEFAULT_PREFS)) as Record<string, unknown>;
      await writeKey("prefs", { ...cur, ...patch });
      // 系统提示词变了：清掉所有讲的会话 id，让新人格在下一条消息生效（UI 历史保留）。
      if ("systemPrompt" in patch && (patch.systemPrompt ?? "") !== (cur.systemPrompt ?? "")) {
        await prisma.chatThread.updateMany({ data: { sessionId: null } });
      }
    });
  }
  // last 键独立（last-writer-wins 语义），不需要锁。
  if (d.last !== undefined) {
    await writeKey("last", d.last);
  }
  return Response.json({ ok: true });
}
