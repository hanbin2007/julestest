"use client";
// 根错误边界:连根布局都崩时兜底(必须自带 html/body)。极简、零依赖,确保任何情况下不白屏。
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#131316",
          color: "#e3e2e6",
          fontFamily: "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>应用出错了</div>
          <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 420, wordBreak: "break-word", marginBottom: 16 }}>
            {error?.message || "发生未预期的异常。"}
          </div>
          <button
            onClick={reset}
            style={{
              padding: "8px 18px",
              borderRadius: 999,
              border: "1px solid #44474f",
              background: "transparent",
              color: "#e3e2e6",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            重新加载
          </button>
        </div>
      </body>
    </html>
  );
}
