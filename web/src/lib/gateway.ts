// 服务端调用 Python 有道网关（仅 localhost）。仅在 route handler / 服务端用，
// 浏览器不直接访问网关。媒体字节(/p,/thumbs)走 next.config rewrites，不经此处。

const GATEWAY = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:8808";

export class GatewayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${GATEWAY}${path}`, { cache: "no-store", ...init });
  } catch (e) {
    // 网关进程没起来 / 连接失败
    throw new GatewayError(502, `gateway unreachable: ${(e as Error).message}`);
  }
  if (!r.ok) {
    throw new GatewayError(r.status, (await r.text()).slice(0, 500));
  }
  return r.json() as Promise<T>;
}

export const gatewayGet = <T>(path: string) => call<T>(path);

export const gatewayPost = <T>(path: string, body: unknown) =>
  call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
