import { NextRequest } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /ink-tune 调参台候选参数落盘:iPad Safari 在非 HTTPS 源上没有 navigator.clipboard,「复制参数」用不了。
// 改为页面挂载时把候选(从设备 localStorage 恢复的 tuning + strokes)POST 上来,落到本机文件,
// 供 agent / 开发者直接读取后手贴回 inkTuning.ts。纯本地自托管工具,不鉴权。
const FILE = path.join(os.homedir(), ".youdao_course", "inktune-candidate.json");

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    JSON.parse(body); // 校验是合法 JSON,坏数据早拒
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, body, "utf8");
    return Response.json({ ok: true, bytes: body.length });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message) }, { status: 400 });
  }
}

export async function GET() {
  try {
    const data = await fs.readFile(FILE, "utf8");
    return new Response(data, { headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ ok: false, error: "尚无已保存的候选参数(请在 /ink-tune 刷新一次以同步)" }, { status: 404 });
  }
}
