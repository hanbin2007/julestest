import { NextRequest } from "next/server";
import { readChatImage } from "@/lib/chatImages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 取某条对话消息的附图（批注画面，JPEG）。
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return new Response("no id", { status: 400 });
  const buf = await readChatImage(id);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
}
