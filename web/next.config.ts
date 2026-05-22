import type { NextConfig } from "next";

// 后端(Python 代理) 地址。同源 rewrites 把 /api、/p、/thumbs 透传给它，
// 因此浏览器始终只跟 Next 同源通信（无 CORS），且 Range/206 在网络层原样透传。
const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8808";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
      { source: "/p", destination: `${BACKEND}/p` },
      { source: "/thumbs/:path*", destination: `${BACKEND}/thumbs/:path*` },
    ];
  },
};

export default nextConfig;
