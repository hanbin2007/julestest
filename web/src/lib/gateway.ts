// 服务端调用 Python 有道网关（仅 localhost）。仅在 route handler / 服务端用，
// 浏览器不直接访问网关。媒体字节(/p,/thumbs)走 next.config rewrites，不经此处。

const GATEWAY = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:8808";

export class GatewayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

async function call<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 90000,
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${GATEWAY}${path}`, {
      cache: "no-store",
      // signal 放在 ...init 之前，调用方若自带 signal 仍生效
      signal: AbortSignal.timeout(timeoutMs),
      ...init,
    });
  } catch (e) {
    const name = (e as Error).name;
    // AbortSignal.timeout 触发的超时：别让挂死的网关一直占着请求
    if (name === "TimeoutError" || name === "AbortError") {
      throw new GatewayError(504, "gateway timeout");
    }
    // 网关进程没起来 / 连接失败
    throw new GatewayError(502, `gateway unreachable: ${(e as Error).message}`);
  }
  if (!r.ok) {
    throw new GatewayError(r.status, (await r.text()).slice(0, 500));
  }
  return r.json() as Promise<T>;
}

export const gatewayGet = <T>(path: string, timeoutMs?: number) =>
  call<T>(path, undefined, timeoutMs);

export const gatewayPost = <T>(path: string, body: unknown, timeoutMs?: number) =>
  call<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
