import { refreshCatalog } from "@/lib/catalog";
import { GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 主动刷新目录:重拉课程列表 + 清空视频缓存(按需重拉)。
export async function POST() {
  try {
    const count = await refreshCatalog();
    return Response.json({ ok: true, courses: count });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
