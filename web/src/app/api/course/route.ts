import { NextRequest } from "next/server";
import { getCourseVideos } from "@/lib/catalog";
import { GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 某课视频列表:优先从 DB 读;该课首次访问才向网关拉取并落库。
export async function GET(req: NextRequest) {
  const productId = Number(
    new URL(req.url).searchParams.get("productId") ?? "",
  );
  if (!productId) {
    return Response.json({ error: "missing productId" }, { status: 400 });
  }
  try {
    return Response.json({ videos: await getCourseVideos(productId) });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json(
      { error: (e as Error).message, videos: [] },
      { status },
    );
  }
}
