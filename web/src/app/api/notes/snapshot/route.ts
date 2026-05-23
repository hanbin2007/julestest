import { NextRequest } from "next/server";
import { readSnap, saveSnap } from "@/lib/noteSnaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 批注合成图分辨率更高（最宽 1600 的 JPEG），放宽到 3MB。
const MAX_BYTES = 3 * 1024 * 1024;

// 保存某条笔记的手动截图（记笔记时抓的当前画面，JPEG dataURL）。
export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  const id = String(d.id ?? "");
  const image = String(d.image ?? "");
  if (!id || !image) return Response.json({ error: "need id+image" }, { status: 400 });
  const m = image.match(/^data:image\/jpeg;base64,(.+)$/); // 仅收 JPEG，避免歧义
  if (!m) return Response.json({ error: "need jpeg dataURL" }, { status: 400 });
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  await saveSnap(id, buf);
  return Response.json({ ok: true });
}

// 取某条笔记的截图。批注再编辑会覆盖同一 id 的图，故不能用 immutable；
// 用可重验的短缓存（局域网工具，重验成本可忽略）。
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return new Response("no id", { status: 400 });
  const buf = await readSnap(id);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "no-cache",
    },
  });
}
