import { NextRequest } from "next/server";
import { syncYoudaoProgress } from "@/lib/youdaoSync";
import { GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 从有道同步观看状态：拉每门课的 playDuration/study，按「不回退、已学完为准」合并进本地进度。
// body 可选 { productId }：缺省同步全部课程。会跑 N 次有道 detail（限并发 4），可能耗时数十秒。
export async function POST(req: NextRequest) {
  const d = await req.json().catch(() => ({}));
  const productId = d?.productId != null ? Number(d.productId) : undefined;
  try {
    const result = await syncYoudaoProgress(
      Number.isFinite(productId) ? (productId as number) : undefined,
    );
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
