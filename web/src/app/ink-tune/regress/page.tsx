"use client";
import * as React from "react";
import { useAnnotation } from "@/components/annotate/useAnnotation";
import AnnotationLayer from "@/components/annotate/AnnotationLayer";

// 生产回归夹具:挂【裸】AnnotationLayer(不传 onCommitStroke = 生产路径,落笔 api.push)。
// 重构后若 push 路径或渲染坏了,这里能抓到。默认工具就是 pen(useAnnotation 初值)。
export default function InkTuneRegress() {
  const api = useAnnotation();
  const apiRef = React.useRef(api);
  apiRef.current = api;
  const hostRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    (window as typeof window & { __regress?: unknown }).__regress = {
      objectCount: () => apiRef.current.objects.length,
      // committed 是 wrap 里的第一个 canvas(见 AnnotationLayer 渲染顺序)
      committedDataURL: () =>
        (hostRef.current?.querySelector("canvas") as HTMLCanvasElement | null)?.toDataURL() ?? "",
    };
    return () => {
      delete (window as typeof window & { __regress?: unknown }).__regress;
    };
  });
  return (
    <div ref={hostRef} style={{ position: "relative", width: 800, height: 500, background: "#000" }}>
      <AnnotationLayer api={api} />
    </div>
  );
}
