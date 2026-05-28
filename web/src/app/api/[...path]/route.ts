import { NextRequest } from "next/server";

// 兜底代理：把尚未由 Next 接管的 /api/* 透传给 Python 网关，保证迁移过程中应用始终可用。
// 迁移过程中会逐步加上更具体的 route handler（如 /api/courses），它们的优先级高于本兜底。
// 注意：媒体字节 /p、/thumbs 不走这里（由 next.config rewrites 直连网关，支持 Range/流式）。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATEWAY = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:8808";

// 已下线的网关镜像路由：曾由 web 单独 route 处理(/api/status 旧版会做第二份不完整 DB 镜像)。
// 现已删除 + 状态镜像唯一收口于 /api/courses/status。这里显式 404，防止落到兜底代理后
// 又被透传到网关 /api/status（网关该端点仍存在，供 /api/courses/status 服务端调用）。
const BLOCKED = new Set(["status"]);

async function proxy(req: NextRequest, path: string[]) {
  if (path.length === 1 && BLOCKED.has(path[0])) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const search = new URL(req.url).search;
  const target = `${GATEWAY}/api/${path.join("/")}${search}`;
  const init: RequestInit = {
    method: req.method,
    cache: "no-store",
    signal: AbortSignal.timeout(90000),
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
    init.headers = {
      "content-type": req.headers.get("content-type") ?? "application/json",
    };
  }
  try {
    const r = await fetch(target, init);
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return Response.json({ error: "gateway timeout" }, { status: 504 });
    }
    return Response.json(
      { error: `gateway unreachable: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
