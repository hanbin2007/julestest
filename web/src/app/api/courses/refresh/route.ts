import { refreshCatalog } from "@/lib/catalog";
import { GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 主动刷新目录:重拉课程列表 + 标记各课讲次待更新(下次打开按需重拉;不清缓存,笔记/进度对应不丢)。
export async function POST() {
  try {
    const count = await refreshCatalog();
    return Response.json({ ok: true, courses: count });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
