import type { NextConfig } from "next";

// Python 有道网关地址。/api/* 现由 Next route handlers 处理（DB 支撑），不再 rewrite；
// 仅媒体字节 /p、/thumbs 在网络层透传给网关（支持 Range/206、流式，零拷贝）。
const GATEWAY = process.env.GATEWAY_ORIGIN ?? process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8808";

const nextConfig: NextConfig = {
  // 把工作区根锁定在本目录，避免 Next 误把 ~ 下的 lockfile 当成项目根。
  outputFileTracingRoot: __dirname,
  // Claude Agent SDK 自带 claude 二进制并 spawn 子进程，别让 webpack 打包它（会破坏二进制解析）。
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // 允许局域网内其它设备访问 dev server（避免 Next 15 跨源开发请求被拦）。
  allowedDevOrigins: ["192.168.0.126"],
  async rewrites() {
    return [
      { source: "/p", destination: `${GATEWAY}/p` },
      { source: "/thumbs/:path*", destination: `${GATEWAY}/thumbs/:path*` },
    ];
  },
};

export default nextConfig;
