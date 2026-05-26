import { NextRequest } from "next/server";
import { gatewayPost, GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 网关 /api/warm 透传：给一批 (videoId, contentId, cardPackageId, productId, src, liveId?),
// 网关只取 m3u8 学到分片顺序+总数，不下分片。
// 设置页 /api/courses/status 路由会自动触发；前端无需直接调用。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const videos = Array.isArray(body.videos) ? body.videos : [];
  try {
    const r = await gatewayPost("/api/warm", { videos });
    return Response.json(r);
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
