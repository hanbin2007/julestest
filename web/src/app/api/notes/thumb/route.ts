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
  const sp = new URL(req.url).searchParams;
  const videoId = Number(sp.get("videoId") ?? "");
  if (!videoId) return Response.json({ state: "error", reason: "no videoId" }, { status: 400 });

  // videoId 跨课不唯一：有 productId（笔记自带）就按 (productId, videoId) 精确取该课的 Video 行，
  // 避免 findFirst 按 productId 升序选到「最低 productId 那门课」的错行（再据其转发网关参数）。
  // 老笔记无 productId（或精确行缺失）时回退 findFirst，保持原行为。
  const productId = Number(sp.get("productId") ?? "");
  let row =
    productId > 0
      ? await prisma.video.findUnique({ where: { productId_videoId: { productId, videoId } } })
      : null;
  if (!row) row = await prisma.video.findFirst({ where: { videoId }, orderBy: { productId: "asc" } });
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

  // 镜像状态进 DB（失败不影响返回）。全部状态都写: ready/gen/error/cancelled。
  // 之前只写 ready/gen → error/cancelled 被吞, DB 回退里该讲永远显示 "gen"(假进行中)。
  try {
    if (r.state === "ready") {
      const data = { state: "ready", url: r.url, number: r.number, column: r.column, width: r.width, height: r.height };
      await prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, ...data }, update: data });
    } else {
      // gen/error/cancelled: 写状态本身; 非 ready 清掉旧 sprite 几何, 避免残留误用。
      const data = { state: r.state, url: null, number: null, column: null, width: null, height: null };
      await prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, ...data }, update: data });
    }
  } catch {
    /* mirror best-effort */
  }
  return Response.json(r);
}
