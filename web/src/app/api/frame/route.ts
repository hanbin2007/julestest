import { NextRequest } from "next/server";
import { spawn } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 在服务端用 ffmpeg 从网关 /p 解密流里抓「时间 t 的整帧」。
// 为什么不在浏览器抓：HLS/MSE 视频在 macOS/iPad 上 drawImage 到 canvas 常得到纯黑帧
// （硬件解码 overlay 不可读），所以批注/发图必须走服务端取帧。
const GATEWAY = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:8808";

function runFfmpeg(args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let ff;
    try {
      ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e as Error);
    }
    const chunks: Buffer[] = [];
    let err = "";
    const to = setTimeout(() => {
      ff.kill("SIGKILL");
      reject(new Error("ffmpeg timeout"));
    }, timeoutMs);
    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
    ff.on("close", (code) => {
      clearTimeout(to);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(err.slice(0, 300) || `ffmpeg rc=${code}`));
    });
  });
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const src = sp.get("src") ?? ""; // 播放器在用的 /p?u=...&vid=... 路径
  const t = Math.max(0, Math.floor(Number(sp.get("t") ?? "0")) || 0);
  // 防 SSRF：只允许网关的 /p 代理路径
  if (!src.startsWith("/p?")) return new Response("bad src", { status: 400 });

  const input = `${GATEWAY}${src}`;
  const args = [
    "-y",
    "-nostdin",
    // 代理段地址无 .ts 后缀，ffmpeg 8 默认会拒绝，需放开扩展名校验（与缩略图一致）
    "-allowed_extensions",
    "ALL",
    "-extension_picky",
    "0",
    "-ss",
    String(t), // 输入前 seek：快
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1280,iw)':-2",
    "-q:v",
    "3",
    "-f",
    "mjpeg",
    "pipe:1",
    "-loglevel",
    "error",
  ];

  try {
    const buf = await runFfmpeg(args, 30000);
    if (!buf || buf.length === 0) return new Response("no frame", { status: 502 });
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response("frame failed: " + (e as Error).message, { status: 500 });
  }
}
