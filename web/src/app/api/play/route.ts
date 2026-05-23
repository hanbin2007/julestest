import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { gatewayGet, GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 取流:网关解析 m3u8 + 返回 /p 代理地址(浏览器经 rewrite 直取媒体字节)。
// 顺带在服务端记录 last-watched(深链/任意客户端取流都生效)。
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const videoId = Number(sp.get("videoId"));
  const productId = Number(sp.get("productId"));
  try {
    const r = await gatewayGet<{ url: string; m3u8: string }>(
      `/api/play?${sp.toString()}`,
    );
    if (videoId && productId) {
      const value = JSON.stringify({ productId, videoId });
      void prisma.setting
        .upsert({ where: { key: "last" }, create: { key: "last", value }, update: { value } })
        .catch(() => {});
    }
    return Response.json(r);
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
