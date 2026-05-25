"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { Box, Chip, CircularProgress, Dialog, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import GestureRoundedIcon from "@mui/icons-material/GestureRounded";
import MovieRoundedIcon from "@mui/icons-material/MovieRounded";
import { noteSnapshotUrl } from "@/lib/api";
import { fetcher } from "@/lib/fetcher";
import { fmtDur, thumbSheetUrl, thumbTile } from "@/lib/media";
import type { ThumbResponse } from "@/types/api";
import type { EnrichedNote } from "@/lib/store";

// videoId 跨课不唯一：把笔记的 courseId(=productId) 一并带给 /api/notes/thumb，
// 让后端按 (productId, videoId) 精确取该课的 Video 行（否则会取到最低 productId 那门课的错行）。
// 不走 api.ts 的 getNoteThumb 是因其签名只收 videoId；这里直连同一接口、复用 fetcher。
function fetchNoteThumb(videoId: number, courseId?: number) {
  const pid = courseId && courseId > 0 ? `&productId=${courseId}` : "";
  return fetcher<ThumbResponse>(`/api/notes/thumb?videoId=${videoId}${pid}`);
}

// 懒加载 Markdown + KaTeX（与对话/全屏阅读同一份），AI 问答类笔记按 Markdown 渲染。
const Markdown = dynamic(() => import("@/components/chat/Markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => null,
});

// 组合预览弹窗：大图（截图/雪碧图帧）+ 文字（Markdown/LaTeX）+ 跳转/编辑批注。
// z-index 抬到 ArtPlayer 网页全屏(9999)之上、Toast(100000)之下，分屏/全屏也盖得住（同 MarkdownReader）。
export default function NoteViewer({
  note,
  open,
  onClose,
  onJump,
  onEditAnnotation,
}: {
  note: EnrichedNote | null;
  open: boolean;
  onClose: () => void;
  onJump: (courseId: number, videoId: number, t: number) => void;
  onEditAnnotation?: (courseId: number, videoId: number, t: number, id: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth slotProps={{ root: { sx: { zIndex: 99000 } } }}>
      {note && (
        <Box sx={{ display: "flex", flexDirection: "column", maxHeight: "92dvh" }}>
          {/* 头部 */}
          <Stack
            direction="row"
            sx={{ alignItems: "center", gap: 1, px: 2, py: 1.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
          >
            <Typography variant="caption" sx={{ color: "primary.main", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {fmtDur(note.t) || "0:00"}
            </Typography>
            {!!note.strokes && (
              <Chip
                size="small"
                variant="outlined"
                icon={<GestureRoundedIcon />}
                label="批注"
                sx={{ height: 20, "& .MuiChip-label": { px: 0.75, fontSize: 11 } }}
              />
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" noWrap title={`${note.courseName} · ${note.lessonTitle}`}>
                {note.lessonTitle}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {note.courseName}
              </Typography>
            </Box>
            <Tooltip title="跳转看课">
              <IconButton size="small" onClick={() => onJump(note.courseId, note.videoId, note.t)} aria-label="jump to watch">
                <PlayArrowRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {!!note.strokes && onEditAnnotation && (
              <Tooltip title="编辑批注">
                <IconButton
                  size="small"
                  onClick={() => onEditAnnotation(note.courseId, note.videoId, note.t, note.id)}
                  aria-label="edit annotation"
                >
                  <GestureRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <IconButton size="small" onClick={onClose} aria-label="close preview">
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Stack>

          {/* 内容：大图 + 文字（可滚动） */}
          <Box sx={{ overflowY: "auto", p: { xs: 2, md: 3 } }}>
            <NoteFrame note={note} />
            <Box sx={{ mt: 2, fontSize: "1.02rem" }}>
              <Markdown>{note.text}</Markdown>
            </Box>
          </Box>
        </Box>
      )}
    </Dialog>
  );
}

// 大图帧：① 手动截图(hasSnap) → ② 雪碧图帧(就绪) → ③ 缺图时现场生成(网关落盘) → ④ 占位。
// 弹窗打开即可见，无需懒触发；雪碧图按实际容器宽度算 tile（响应式不跑偏）。
function NoteFrame({ note }: { note: EnrichedNote }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = React.useState(640);
  const [liveMeta, setLiveMeta] = React.useState<{ url?: string | null; number?: number | null; column?: number | null; width?: number | null; height?: number | null } | null>(null);
  const [gen, setGen] = React.useState<"idle" | "gen" | "error">("idle");
  const [snapErr, setSnapErr] = React.useState(false);
  const [spriteErr, setSpriteErr] = React.useState(false);

  const showSnap = note.hasSnap && !snapErr;
  const ready = note.thumbState === "ready";
  const spriteOk = (ready || !!liveMeta) && !spriteErr;
  const effMeta = liveMeta ?? note.thumb;
  const url = thumbSheetUrl(note.videoId);
  const tile = thumbTile(note.t, boxW, effMeta ?? undefined);

  // 容器宽度（雪碧图 tile 算法按 px 宽算，响应式要跟随）
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth || 640));
    ro.observe(el);
    setBoxW(el.clientWidth || 640);
    return () => ro.disconnect();
  }, []);

  // 无截图且无雪碧图 → 现场生成 + 轮询
  React.useEffect(() => {
    if (showSnap || ready || liveMeta || spriteErr) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    setGen("gen");
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetchNoteThumb(note.videoId, note.courseId);
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
  }, [note.videoId, showSnap, ready]);

  return (
    <Box
      ref={ref}
      sx={{
        width: "100%",
        bgcolor: "#000",
        borderRadius: (t) => t.radius.md,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {showSnap ? (
        <Box
          component="img"
          src={noteSnapshotUrl(note.id)}
          alt=""
          onError={() => setSnapErr(true)}
          sx={{ display: "block", width: "100%", height: "auto" }}
        />
      ) : spriteOk ? (
        <>
          <Box
            sx={{
              width: "100%",
              aspectRatio: "16 / 9",
              backgroundImage: `url("${url}")`,
              backgroundSize: tile.backgroundSize,
              backgroundPosition: tile.backgroundPosition,
              backgroundRepeat: "no-repeat",
            }}
          />
          {/* 探测雪碧图真的存在（state=ready 但文件可能缺失）→ 回退占位 */}
          <img src={url} alt="" style={{ display: "none" }} onError={() => setSpriteErr(true)} />
        </>
      ) : (
        <Box
          sx={{
            width: "100%",
            aspectRatio: "16 / 9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          {gen === "gen" ? <CircularProgress size={28} color="inherit" /> : <MovieRoundedIcon sx={{ fontSize: 40 }} />}
        </Box>
      )}
    </Box>
  );
}
