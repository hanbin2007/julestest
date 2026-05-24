"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import { createPortal } from "react-dom";
import AnnotationLayer from "./AnnotationLayer";
import AnnotationToolbar from "./AnnotationToolbar";
import type { AnnotationApi } from "./useAnnotation";

// 把批注画布 + 工具条 portal 进 ArtPlayer 的播放器根（art.template.$player）。
// 关键：必须挂在该元素的后代里，原生全屏（art.fullscreen）下才可见。
export default function AnnotationOverlay({
  art,
  api,
  text,
  setText,
  onSaveNote,
  onAskClaude,
  onClose,
  busy,
}: {
  art: any;
  api: AnnotationApi;
  text: string;
  setText: (s: string) => void;
  onSaveNote: () => void;
  onAskClaude: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const root: HTMLElement | undefined = art?.template?.$player;
    if (!root) return;
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;inset:0;z-index:30;";
    root.appendChild(el);
    setHost(el);
    return () => {
      el.remove();
      setHost(null);
    };
  }, [art]);

  if (!host) return null;
  return createPortal(
    <>
      <AnnotationLayer api={api} video={art?.video as HTMLVideoElement | undefined} />
      <AnnotationToolbar
        api={api}
        bounds={host}
        text={text}
        setText={setText}
        onSaveNote={onSaveNote}
        onAskClaude={onAskClaude}
        onClose={onClose}
        busy={busy}
      />
    </>,
    host
  );
}
