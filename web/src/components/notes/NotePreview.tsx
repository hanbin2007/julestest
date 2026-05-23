"use client";
import * as React from "react";
import { Box, CircularProgress, Popper, Typography } from "@mui/material";
import MovieRoundedIcon from "@mui/icons-material/MovieRounded";
import { getNoteThumb, noteSnapshotUrl } from "@/lib/api";
import { fmtDur, thumbSheetUrl, thumbTile } from "@/lib/media";
import type { ThumbMeta } from "@/lib/store";

const PREVIEW_W = 132; // 卡片内小图宽（16:9 → 高约 74）
const POPPER_W = 360; // 悬停放大图宽
const PREVIEW_H = (PREVIEW_W * 9) / 16;
const POPPER_H = (POPPER_W * 9) / 16;

// 时间戳角标
function TimeBadge({ t }: { t: number }) {
  return (
    <Typography
      variant="caption"
      sx={{
        position: "absolute",
        right: 4,
        bottom: 2,
        px: 0.5,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        color: "common.white",
        textShadow: "0 1px 3px rgba(0,0,0,.85)",
      }}
    >
      {fmtDur(t) || "0:00"}
    </Typography>
  );
}

// 笔记预览，优先级：① 记笔记时抓的手动截图(hasSnap，精确即时) → ② 雪碧图帧(就绪) →
// ③ 缺图时进入视口后现场生成(网关落盘) → ④ 占位。悬停(有 hover 的设备)放大。
export default function NotePreview({
  noteId,
  videoId,
  t,
  ready,
  hasSnap,
  meta,
  color,
}: {
  noteId: string;
  videoId: number;
  t: number;
  ready: boolean;
  hasSnap: boolean;
  meta?: ThumbMeta;
  color: string;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = React.useState(false);
  const [liveMeta, setLiveMeta] = React.useState<ThumbMeta | null>(null);
  const [gen, setGen] = React.useState<"idle" | "gen" | "error">("idle");
  const [errored, setErrored] = React.useState(false); // 雪碧图缺失
  const [snapErrored, setSnapErrored] = React.useState(false); // 截图缺失
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSnap = hasSnap && !snapErrored;
  const spriteOk = (ready || !!liveMeta) && !errored;
  const canZoom = showSnap || spriteOk;
  const effMeta = liveMeta ?? meta;
  const url = thumbSheetUrl(videoId);
  const small = thumbTile(t, PREVIEW_W, effMeta ?? undefined);
  const big = thumbTile(t, POPPER_W, effMeta ?? undefined);

  // 进入视口才工作（懒触发，避免一次性给网关压上几十路生成）
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  // 无截图且无雪碧图 → 进入视口后现场生成 + 轮询，直到就绪/出错
  React.useEffect(() => {
    if (showSnap || ready || liveMeta || errored || !inView) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    setGen("gen");
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await getNoteThumb(videoId);
        if (cancelled) return;
        if (r.state === "ready") {
          setLiveMeta({ url: r.url, number: r.number, column: r.column, width: r.width, height: r.height });
          setGen("idle");
          return;
        }
        if (r.state === "error") {
          setGen("error");
          return;
        }
      } catch {
        /* 网络抖动，重试 */
      }
      if (++tries < 60 && !cancelled) timer = setTimeout(tick, 2000);
      else if (!cancelled) setGen("error");
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, videoId, ready, showSnap]);

  const enter = (e: React.MouseEvent<HTMLElement>) => {
    if (!canZoom) return;
    const el = e.currentTarget;
    hoverTimer.current = setTimeout(() => setAnchor(el), 150); // 入场延迟，滚动时不闪
  };
  const leave = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setAnchor(null);
  };
  React.useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  return (
    <>
      <Box
        ref={rootRef}
        onMouseEnter={enter}
        onMouseLeave={leave}
        sx={{
          width: PREVIEW_W,
          height: PREVIEW_H,
          flex: "0 0 auto",
          position: "relative",
          overflow: "hidden",
          borderRadius: (th) => th.radius.sm,
          bgcolor: `color-mix(in srgb, ${color} 20%, transparent)`,
          cursor: canZoom ? "zoom-in" : "default",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {showSnap ? (
          <Box
            component="img"
            src={noteSnapshotUrl(noteId)}
            alt=""
            onError={() => setSnapErrored(true)}
            sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : spriteOk ? (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url("${url}")`,
              backgroundSize: small.backgroundSize,
              backgroundPosition: small.backgroundPosition,
              backgroundRepeat: "no-repeat",
            }}
          />
        ) : gen === "gen" ? (
          <CircularProgress size={20} sx={{ color }} />
        ) : (
          <MovieRoundedIcon sx={{ color, opacity: 0.6, fontSize: 26 }} />
        )}
        <TimeBadge t={t} />
      </Box>
      {/* 探测雪碧图是否真的存在（state=ready 但文件可能缺失）→ 回退 */}
      {!showSnap && spriteOk && (
        <img src={url} alt="" style={{ display: "none" }} onError={() => setErrored(true)} />
      )}
      <Popper
        open={!!anchor}
        anchorEl={anchor}
        placement="right"
        sx={{ pointerEvents: "none", zIndex: (th) => th.zIndex.tooltip }}
        modifiers={[{ name: "offset", options: { offset: [0, 8] } }]}
      >
        <Box
          sx={{
            borderRadius: (th) => th.radius.md,
            overflow: "hidden",
            boxShadow: 8,
            border: (th) => `1px solid ${th.palette.divider}`,
            bgcolor: "#000",
          }}
        >
          {showSnap ? (
            <Box
              component="img"
              src={noteSnapshotUrl(noteId)}
              alt=""
              sx={{ width: POPPER_W, height: POPPER_H, objectFit: "cover", display: "block" }}
            />
          ) : (
            <Box
              sx={{
                width: POPPER_W,
                height: POPPER_H,
                backgroundImage: `url("${url}")`,
                backgroundSize: big.backgroundSize,
                backgroundPosition: big.backgroundPosition,
                backgroundRepeat: "no-repeat",
              }}
            />
          )}
        </Box>
      </Popper>
    </>
  );
}
