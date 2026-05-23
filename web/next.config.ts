import type { NextConfig } from "next";

// 后端(Python 代理) 地址。同源 rewrites 把 /api、/p、/thumbs 透传给它，
// 因此浏览器始终只跟 Next 同源通信（无 CORS），且 Range/206 在网络层原样透传。
const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8808";

const nextConfig: NextConfig = {
  // 把工作区根锁定在本目录，避免 Next 误把 ~ 下的 lockfile 当成项目根。
  outputFileTracingRoot: __dirname,
  // 允许局域网内其它设备访问 dev server（避免 Next 15 跨源开发请求被拦）。
  allowedDevOrigins: ["192.168.0.126"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
      { source: "/p", destination: `${BACKEND}/p` },
      { source: "/thumbs/:path*", destination: `${BACKEND}/thumbs/:path*` },
    ];
  },
};

export default nextConfig;
