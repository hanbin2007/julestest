import { prisma } from "@/lib/db";
import { gatewayGet } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GwStatus {
  thumb: {
    states: Record<string, string>;
    ready: number;
    generating: string[];
    queued: number;
    errors: number;
  };
  buffer: {
    perVid: Record<string, { cached: number; total: number | null; state: string | null }>;
    bytes: number;
    limit: number;
    queued: number;
    working: string[];
  };
  ffmpeg: boolean;
  thumbDir: string;
}

// 缓存/缩略图状态:网关是真相;Next 镜像进 DB(跨设备 + 网关重启时仍可显示最近状态)。
export async function GET() {
  try {
    const s = await gatewayGet<GwStatus>("/api/status");
    const ops = [];
    for (const [vid, b] of Object.entries(s.buffer?.perVid ?? {})) {
      const videoId = Number(vid);
      if (!videoId) continue;
      const data = {
        cachedSegments: b.cached || 0,
        totalSegments: b.total ?? null,
        state: b.state ?? null,
      };
      ops.push(
        prisma.cacheStatus.upsert({ where: { videoId }, create: { videoId, ...data }, update: data }),
      );
    }
    for (const [vid, st] of Object.entries(s.thumb?.states ?? {})) {
      const videoId = Number(vid);
      if (!videoId) continue;
      ops.push(
        prisma.thumbStatus.upsert({ where: { videoId }, create: { videoId, state: st }, update: { state: st } }),
      );
    }
    if (ops.length) await prisma.$transaction(ops).catch(() => {});
    return Response.json(s);
  } catch {
    // 网关不可用 -> 回退到 DB 最近已知状态
    const [cs, ts] = await Promise.all([
      prisma.cacheStatus.findMany(),
      prisma.thumbStatus.findMany(),
    ]);
    const perVid: Record<string, { cached: number; total: number | null; state: string | null }> = {};
    for (const r of cs)
      perVid[String(r.videoId)] = { cached: r.cachedSegments, total: r.totalSegments, state: r.state };
    const states: Record<string, string> = {};
    for (const r of ts) states[String(r.videoId)] = r.state;
    return Response.json({
      thumb: {
        states,
        ready: ts.filter((r) => r.state === "ready").length,
        generating: [],
        queued: 0,
        errors: ts.filter((r) => r.state === "error").length,
      },
      buffer: {
        perVid,
        bytes: 0,
        limit: 0,
        queued: 0,
        working: cs.filter((r) => r.state === "working").map((r) => String(r.videoId)),
      },
      ffmpeg: true,
      thumbDir: "",
      stale: true,
    });
  }
}
