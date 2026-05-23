import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { gatewayGet, GatewayError } from "@/lib/gateway";
import { pickLow } from "@/lib/media";
import type { ThumbResponse, Video } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 按 videoId 现场生成/查询该讲缩略图（笔记预览缺图时触发）。
// 从 Video.raw 还原 ids + 低清 m3u8，转发网关 /api/thumb（网关会落盘持久保存）；
// 就绪/生成中则镜像进 ThumbStatus，使 /api/notes/all 与播放器状态保持一致。
export async function GET(req: NextRequest) {
  const videoId = Number(new URL(req.url).searchParams.get("videoId") ?? "");
  if (!videoId) return Response.json({ state: "error", reason: "no videoId" }, { status: 400 });

  const row = await prisma.video.findFirst({ where: { videoId }, orderBy: { productId: "asc" } });
  if (!row) return Response.json({ state: "error", reason: "no video" });

  let v: Video;
  try {
    v = JSON.parse(row.raw) as Video;
  } catch {
    return Response.json({ state: "error", reason: "bad raw" });
  }
  const low = pickLow(v);
  if (!low || v.contentId == null || v.cardPackageId == null) {
    return Response.json({ state: "error", reason: "missing src/ids" });
  }

  const q =
    `videoId=${videoId}&contentId=${v.contentId}&cardPackageId=${v.cardPackageId}` +
    `&productId=${row.productId}&duration=${v.duration ?? 0}&src=${encodeURIComponent(low)}`;
  let r: ThumbResponse;
  try {
    r = await gatewayGet<ThumbResponse>(`/api/thumb?${q}`);
  } catch (e) {
    const reason = e instanceof GatewayError ? e.message : (e as Error).message;
    return Response.json({ state: "error", reason });
  }

  // 镜像状态进 DB（失败不影响返回）
  try {
    if (r.state === "ready") {
      const data = { state: "ready", url: r.url, number: r.number, column: r.column, width: r.width, height: r.height };
      await prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, ...data }, update: data });
    } else if (r.state === "gen") {
      await prisma.thumbStatus.upsert({
        where: { videoId },
        create: { videoId, state: "gen" },
        update: { state: "gen" },
      });
    }
  } catch {
    /* mirror best-effort */
  }
  return Response.json(r);
}
