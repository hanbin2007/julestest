import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { gatewayPost, GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 触发整集缓冲:转发给网关执行;同时在 DB 标记意图(queued)，让其它设备/重启后可见。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const videos = Array.isArray(body.videos) ? body.videos : [];
  let result: unknown;
  try {
    result = await gatewayPost("/api/buffer/batch", { videos });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
  const ops = videos
    .map((v: { videoId?: number }) => Number(v?.videoId))
    .filter((id: number) => !!id)
    .map((videoId: number) =>
      prisma.cacheStatus.upsert({
        where: { videoId },
        create: { videoId, state: "queued" },
        update: { state: "queued" },
      }),
    );
  if (ops.length) await prisma.$transaction(ops).catch(() => {});
  return Response.json(result);
}
