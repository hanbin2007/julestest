import { NextRequest } from "next/server";
import { gatewayPost, GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 设置缓存目录:转发给网关校验(可写) + 持久化到 config.json。改动在网关下次启动生效;
// 当前会话仍写旧目录(响应里的 active)。网关把错误装在 {error} JSON 里,这里解出来回前端。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const dir = typeof body?.dir === "string" ? body.dir : "";
  try {
    const result = await gatewayPost("/api/cache-dir", { dir });
    return Response.json(result);
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 502;
    let message = (e as Error).message;
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch {
      /* 非 JSON(如网关不可达) → 沿用原始消息 */
    }
    return Response.json({ error: message }, { status });
  }
}
