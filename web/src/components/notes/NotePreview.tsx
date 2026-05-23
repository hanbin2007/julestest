"use client";
import * as React from "react";
import { Box, Popper, Typography } from "@mui/material";
import MovieRoundedIcon from "@mui/icons-material/MovieRounded";
import { fmtDur, thumbSheetUrl, thumbTile } from "@/lib/media";
import type { ThumbMeta } from "@/lib/store";

const PREVIEW_W = 132; // 卡片内小图宽（16:9 → 高约 74）
const POPPER_W = 360; // 悬停放大图宽

// 时间戳角标（小图/占位通用）
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

// 某条笔记时间戳处的视频帧预览：就绪则裁雪碧图，否则占位；悬停(仅有 hover 的设备)放大。
export default function NotePreview({
  videoId,
  t,
  ready,
  meta,
  color,
}: {
  videoId: number;
  t: number;
  ready: boolean;
  meta?: ThumbMeta;
  color: string;
}) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const [errored, setErrored] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const ok = ready && !errored;
  const url = thumbSheetUrl(videoId);
  const small = thumbTile(t, PREVIEW_W, meta);
  const big = thumbTile(t, POPPER_W, meta);

  const enter = (e: React.MouseEvent<HTMLElement>) => {
    if (!ok) return;
    const el = e.currentTarget;
    timer.current = setTimeout(() => setAnchor(el), 150); // 入场延迟，滚动时不闪
  };
  const leave = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setAnchor(null);
  };
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const frame = {
    width: PREVIEW_W,
    height: (PREVIEW_W * 9) / 16,
    flex: "0 0 auto",
    position: "relative" as const,
    overflow: "hidden",
    borderRadius: (th: { radius: { sm: string } }) => th.radius.sm,
    bgcolor: `color-mix(in srgb, ${color} 20%, transparent)`,
  };

  if (!ok) {
    return (
      <Box sx={{ ...frame, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <MovieRoundedIcon sx={{ color, opacity: 0.6, fontSize: 26 }} />
        <TimeBadge t={t} />
      </Box>
    );
  }

  return (
    <>
      <Box
        onMouseEnter={enter}
        onMouseLeave={leave}
        sx={{
          ...frame,
          cursor: "zoom-in",
          backgroundImage: `url("${url}")`,
          backgroundSize: small.backgroundSize,
          backgroundPosition: small.backgroundPosition,
          backgroundRepeat: "no-repeat",
        }}
      >
        <TimeBadge t={t} />
      </Box>
      {/* 探测雪碧图是否真的存在（state=ready 但文件可能缺失）→ 回退占位 */}
      <img src={url} alt="" style={{ display: "none" }} onError={() => setErrored(true)} />
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
          }}
        >
          <Box
            sx={{
              width: POPPER_W,
              height: (POPPER_W * 9) / 16,
              bgcolor: "#000",
              backgroundImage: `url("${url}")`,
              backgroundSize: big.backgroundSize,
              backgroundPosition: big.backgroundPosition,
              backgroundRepeat: "no-repeat",
            }}
          />
        </Box>
      </Popper>
    </>
  );
}
