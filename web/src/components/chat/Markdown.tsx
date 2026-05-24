"use client";
import * as React from "react";
import { Box } from "@mui/material";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css"; // 仅在对话面板用到时才加载这份样式

// Claude 常用 \(...\) / \[...\] 包公式，而 remark-math 只认 $...$ / $$...$$，先归一化。
function normalizeMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `\n$$\n${body}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`);
}

const components: Components = {
  // 链接新开页，避免在 LAN 工具里被导航走
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

// 渲染助教回复：Markdown（含表格/任务列表）+ LaTeX 公式。样式用后代选择器收敛在气泡内。
function MarkdownImpl({ children }: { children: string }) {
  return (
    <Box
      sx={{
        fontSize: "0.875rem",
        lineHeight: 1.6,
        wordBreak: "break-word",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& p": { my: 0.75 },
        "& h1,& h2,& h3,& h4": { my: 1, lineHeight: 1.3, fontWeight: 600 },
        "& h1": { fontSize: "1.15rem" },
        "& h2": { fontSize: "1.05rem" },
        "& h3,& h4": { fontSize: "0.95rem" },
        "& ul,& ol": { my: 0.75, pl: 2.5 },
        "& li": { my: 0.25 },
        "& a": { color: "primary.main", textDecorationColor: "currentColor" },
        "& code": {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "0.85em",
          px: 0.5,
          py: 0.125,
          borderRadius: (t) => t.radius.sm,
          bgcolor: "md3.surfaceContainerHighest",
        },
        "& pre": {
          my: 1,
          p: 1.25,
          overflowX: "auto",
          borderRadius: (t) => t.radius.sm,
          bgcolor: "md3.surfaceContainerHighest",
        },
        "& pre code": { p: 0, bgcolor: "transparent", fontSize: "0.82em" },
        "& blockquote": {
          my: 1,
          ml: 0,
          pl: 1.5,
          borderLeft: (t) => `3px solid ${t.palette.divider}`,
          color: "text.secondary",
        },
        "& table": { borderCollapse: "collapse", my: 1, fontSize: "0.85em", display: "block", overflowX: "auto" },
        "& th,& td": { border: (t) => `1px solid ${t.palette.divider}`, px: 1, py: 0.5 },
        "& th": { bgcolor: "md3.surfaceContainerHighest", fontWeight: 600 },
        "& hr": { my: 1.5, border: 0, borderTop: (t) => `1px solid ${t.palette.divider}` },
        "& img": { maxWidth: "100%", borderRadius: (t) => t.radius.sm },
        // 长公式横向滚动而非撑破气泡
        "& .katex-display": { overflowX: "auto", overflowY: "hidden", py: 0.5, my: 0.5 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {normalizeMath(children)}
      </ReactMarkdown>
    </Box>
  );
}

// 流式逐字更新会高频重渲染 Markdown，记忆化按文本内容收敛。
export const Markdown = React.memo(MarkdownImpl);
