"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import { createPortal } from "react-dom";
import { Box, Fade, Typography } from "@mui/material";
import { fmtDur, thumbSheetUrl, thumbTile } from "@/lib/media";
import { noteSnapshotUrl } from "@/lib/api";
import type { EnrichedNote } from "@/lib/store";
import { DUR, EASE } from "@/theme/motion";

const PLAIN = "#4f8cff";
const ANNOTATION = "#ffb300"; // 批注用琥珀色区分
const CARD_W = 220;

// 本讲笔记在进度条上打点：鼠标悬浮预览 + 点击跳转；触屏点击=预览（弹窗里再跳，防误点）。
// 挂进 art.template.$player 的进度条里，网页/原生全屏也跟着在。
// 关键：点击用「挂在 host 上的原生捕获监听」处理——React 合成事件在根节点代理，
// stopPropagation 太晚，挡不住 ArtPlayer 注册在 .art-control-progress 上的冒泡 seek；
// 捕获阶段在 host 处先拦下，既不误触进度条 seek，也能区分点的是点位还是悬浮卡。
export default function TimelineMarkers({
  art,
  notes,
  accent = PLAIN,
  onSeek,
  onPreview,
}: {
  art: any;
  notes: EnrichedNote[];
  accent?: string;
  onSeek: (t: number) => void;
  onPreview: (note: EnrichedNote) => void;
}) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const [duration, setDuration] = React.useState(0);
  const [hover, setHover] = React.useState<string | null>(null);
  // 原生监听里读最新值，避免闭包过期
  const onSeekRef = React.useRef(onSeek);
  const onPreviewRef = React.useRef(onPreview);
  const notesRef = React.useRef(notes);
  const lastPointer = React.useRef<string>("mouse");
  onSeekRef.current = onSeek;
  onPreviewRef.current = onPreview;
  notesRef.current = notes;
  // 悬浮卡延迟关闭：从点位移到卡片要跨过 host(pointer-events:none) 的空隙，
  // 不延迟则点位 leave 会先把卡片关掉、指针还没够到卡（卡变得点不到）。
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showCard = (id: string) => {
    clearTimeout(hideTimer.current);
    setHover(id);
  };
  const scheduleHide = (id: string) => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover((h) => (h === id ? null : h)), 140);
  };
  React.useEffect(() => () => clearTimeout(hideTimer.current), []);

  // 把打点容器挂进进度条区域（.art-control-progress 较高，悬浮/点击有竖向余量）。
  React.useEffect(() => {
    const player: HTMLElement | undefined = art?.template?.$player;
    if (!player) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    let el: HTMLDivElement | null = null;
    const onDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType || "mouse";
    };
    const onClickCapture = (e: MouseEvent) => {
      const hit = (e.target as HTMLElement)?.closest?.("[data-note-id]") as HTMLElement | null;
      if (!hit) return; // 点的是进度条本身 → 放行给 ArtPlayer 正常 seek
      e.stopPropagation();
      e.preventDefault();
      const note = notesRef.current.find((n) => n.id === hit.getAttribute("data-note-id"));
      if (!note) return;
      const isCard = hit.hasAttribute("data-note-card");
      if (isCard || lastPointer.current === "touch") onPreviewRef.current(note);
      else onSeekRef.current(note.t);
    };
    const attach = () => {
      const bar = player.querySelector(".art-control-progress") || player.querySelector(".art-control-progress-inner");
      if (bar) {
        el = document.createElement("div");
        el.style.cssText = "position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;z-index:20;";
        el.addEventListener("pointerdown", onDown, true);
        el.addEventListener("click", onClickCapture, true);
        (bar as HTMLElement).appendChild(el);
        setHost(el);
      } else if (++tries < 100) {
        timer = setTimeout(attach, 100);
      }
    };
    attach();
    return () => {
      if (timer) clearTimeout(timer);
      if (el) {
        el.removeEventListener("pointerdown", onDown, true);
        el.removeEventListener("click", onClickCapture, true);
        el.remove();
      }
      setHost(null);
    };
  }, [art]);

  // 时长（位置百分比用）
  React.useEffect(() => {
    if (!art) return;
    const upd = () => setDuration(art.video?.duration || 0);
    upd();
    const v: HTMLVideoElement | undefined = art.video;
    v?.addEventListener("loadedmetadata", upd);
    v?.addEventListener("durationchange", upd);
    try {
      art.on("ready", upd);
    } catch {
      /* ignore */
    }
    return () => {
      v?.removeEventListener("loadedmetadata", upd);
      v?.removeEventListener("durationchange", upd);
      try {
        art.off("ready", upd);
      } catch {
        /* ignore */
      }
    };
  }, [art]);

  if (!host || !duration) return null;

  return createPortal(
    <>
      {notes.map((n) => {
        const pct = Math.min(100, Math.max(0, (n.t / duration) * 100));
        const color = n.strokes ? ANNOTATION : accent;
        return (
          <React.Fragment key={n.id}>
            <Box
              data-note-id={n.id}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") showCard(n.id);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") scheduleHide(n.id);
              }}
              aria-label={`笔记 ${fmtDur(n.t)}`}
              sx={{
                position: "absolute",
                left: `${pct}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: 12,
                height: 12,
                borderRadius: "999px",
                bgcolor: color,
                border: "2px solid #fff",
                boxShadow: "0 1px 4px rgba(0,0,0,.6)",
                pointerEvents: "auto",
                cursor: "pointer",
                transition: `transform ${DUR.short}ms ${EASE}`,
                "&:hover": { transform: "translate(-50%, -50%) scale(1.25)" },
              }}
            />
            <Fade in={hover === n.id} timeout={DUR.short} unmountOnExit>
              <Box
                data-note-id={n.id}
                data-note-card="1"
                onPointerEnter={() => showCard(n.id)}
                onPointerLeave={() => scheduleHide(n.id)}
                sx={{
                  position: "absolute",
                  bottom: "calc(100% + 10px)",
                  left: `clamp(${CARD_W / 2}px, ${pct}%, calc(100% - ${CARD_W / 2}px))`,
                  transform: "translateX(-50%)",
                  width: CARD_W,
                  pointerEvents: "auto",
                  cursor: "pointer",
                  bgcolor: "background.paper",
                  borderRadius: (t) => t.radius.md,
                  boxShadow: 8,
                  border: (t) => `1px solid ${t.palette.divider}`,
                  overflow: "hidden",
                  zIndex: 30,
                }}
              >
                <CardFrame note={n} />
                <Box sx={{ p: 1 }}>
                  <Typography
                    variant="caption"
                    sx={{ color: "primary.main", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtDur(n.t) || "0:00"}
                  </Typography>
                  <Typography
                    variant="caption"
                    component="div"
                    sx={{
                      mt: 0.25,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {n.text}
                  </Typography>
                </Box>
              </Box>
            </Fade>
          </React.Fragment>
        );
      })}
    </>,
    host,
  );
}

// 悬浮卡里的小帧：截图(hasSnap) 优先，否则雪碧图帧；都没有就不显示图（纯文字卡）。
function CardFrame({ note }: { note: EnrichedNote }) {
  const [snapErr, setSnapErr] = React.useState(false);
  const showSnap = note.hasSnap && !snapErr;
  const ready = note.thumbState === "ready";
  const tile = thumbTile(note.t, CARD_W, note.thumb ?? undefined);
  if (showSnap) {
    return (
      <Box
        component="img"
        src={noteSnapshotUrl(note.id)}
        alt=""
        onError={() => setSnapErr(true)}
        sx={{ display: "block", width: "100%", height: (CARD_W * 9) / 16, objectFit: "cover", bgcolor: "#000" }}
      />
    );
  }
  if (ready) {
    return (
      <Box
        sx={{
          width: "100%",
          height: (CARD_W * 9) / 16,
          backgroundImage: `url("${thumbSheetUrl(note.videoId)}")`,
          backgroundSize: tile.backgroundSize,
          backgroundPosition: tile.backgroundPosition,
          backgroundRepeat: "no-repeat",
          bgcolor: "#000",
        }}
      />
    );
  }
  return null;
}
