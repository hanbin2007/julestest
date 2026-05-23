"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import dynamic from "next/dynamic";
import { Alert, Box, Button, Drawer, Typography } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import PlayCircleOutlineRoundedIcon from "@mui/icons-material/PlayCircleOutlineRounded";
import AppTopBar from "@/components/common/AppTopBar";
import CourseSidebar from "@/components/sidebar/CourseSidebar";
import PlayerMeta from "@/components/player/PlayerMeta";
import NotesPanel from "@/components/player/NotesPanel";
import UpNextCountdown from "@/components/player/UpNextCountdown";
import ContinueWatchingRail from "@/components/home/ContinueWatchingRail";
import CommandPalette from "@/components/common/CommandPalette";
import ShortcutsOverlay from "@/components/common/ShortcutsOverlay";
import { PlayerSkeleton } from "@/components/common/Skeletons";
import CacheBar from "@/components/common/CacheBar";
import { useToast } from "@/components/common/Toast";
import { useCourses, useCourseVideos } from "@/hooks/data";
import { useThumbPoll } from "@/hooks/useThumbPoll";
import { useSegmentMaps } from "@/hooks/useSegmentMaps";
import { useHotkeys } from "@/hooks/useHotkeys";
import { play, pickM3u8, postProgress, addNote as apiAddNote, patchSettings, refreshCatalog } from "@/lib/api";
import { themeForSeed, hashSeed } from "@/lib/color";
import { useProgressMap, useLast } from "@/hooks/persist";
import type { Course, Video, VideoRow } from "@/types/api";

const ArtPlayer = dynamic(() => import("@/components/player/ArtPlayer"), {
  ssr: false,
  loading: () => <PlayerSkeleton />,
});

interface Sel {
  courseId: number;
  videoId: number;
}

export default function PlayerView() {
  const toast = useToast();
  const { courses, isLoading, error: coursesError } = useCourses();
  const [refreshing, setRefreshing] = React.useState(false);
  const progressMap = useProgressMap();
  const last = useLast();
  const [sel, setSel] = React.useState<Sel | null>(null);
  const [drawer, setDrawer] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [scOpen, setScOpen] = React.useState(false);
  const [src, setSrc] = React.useState<string | null>(null);
  const [upNext, setUpNext] = React.useState<Video | null>(null);
  const artRef = React.useRef<any>(null);

  const { videos: courseVideos } = useCourseVideos(sel?.courseId ?? null);
  const course: Course | undefined = courses.find((c) => c.id === sel?.courseId);
  const video: Video | undefined = courseVideos.find((v) => v.videoId === sel?.videoId);
  const curList = React.useMemo(() => courseVideos.filter((v) => !v.locked), [courseVideos]);
  const idx = curList.findIndex((v) => v.videoId === sel?.videoId);
  const prev = idx > 0 ? curList[idx - 1] : null;
  const next = idx >= 0 && idx < curList.length - 1 ? curList[idx + 1] : null;

  const thumbnails = useThumbPoll(video ?? null);
  // 本讲逐片缓存：观看/预缓存会持续补片，快一点刷新让缓存条像在“长”。
  const segMaps = useSegmentMaps(video ? [video.videoId] : [], { buckets: 100, refreshInterval: 1500 });
  const segMap = video ? segMaps[String(video.videoId)] : undefined;
  const startTime = React.useMemo(
    () => (sel ? progressMap[String(sel.videoId)]?.t : undefined),
    [sel, progressMap]
  );
  const accentTheme = React.useMemo(
    () => themeForSeed(course ? hashSeed(course.name) : "#4f8cff"),
    [course]
  );

  // 深链 / 上次观看 初始化
  const resumedRef = React.useRef(false);
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const p = Number(sp.get("productId"));
    const v = Number(sp.get("videoId"));
    if (p && v) {
      setSel({ courseId: p, videoId: v });
      resumedRef.current = true;
    }
  }, []);
  // last-watched 从服务端(SWR)加载后再自动续看；只续一次，不覆盖用户已选。
  React.useEffect(() => {
    if (resumedRef.current || sel || !last) return;
    resumedRef.current = true;
    setSel({ courseId: last.productId, videoId: last.videoId });
  }, [last, sel]);

  // 取流
  React.useEffect(() => {
    setSrc(null);
    setUpNext(null);
    if (!video) return;
    const m = pickM3u8(video);
    if (!m) {
      toast("该讲暂无可播放地址（可能未解锁）", { severity: "warning" });
      return;
    }
    let cancelled = false;
    play(video, m)
      .then((r) => !cancelled && setSrc(r.url))
      .catch((e) => !cancelled && toast("取流失败：" + (e as Error).message, { severity: "error" }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.videoId]);

  const selectVideo = React.useCallback((v: Video, c: Course) => {
    setSel({ courseId: c.id, videoId: v.videoId });
    void patchSettings({ last: { productId: c.id, videoId: v.videoId } });
    setDrawer(false);
  }, []);

  const resume = React.useCallback((productId: number, videoId: number) => {
    setSel({ courseId: productId, videoId });
  }, []);

  const pickFromPalette = React.useCallback((row: VideoRow) => {
    setSel({ courseId: row.courseId, videoId: row.v.videoId });
    void patchSettings({ last: { productId: row.courseId, videoId: row.v.videoId } });
  }, []);

  const onTime = React.useCallback(
    (t: number, d: number) => {
      if (!video || !course) return;
      void postProgress(video.videoId, t, d, {
        productId: course.id,
        title: video.title ?? `视频 ${video.videoId}`,
        courseName: course.name,
      });
    },
    [video, course]
  );

  const copyDownload = React.useCallback(() => {
    if (!video) return;
    const cmd = `python3 youdao_course.py download -r req.txt --video ${video.videoId} -o "${video.title ?? video.videoId}.mp4"`;
    navigator.clipboard?.writeText(cmd);
    toast("下载命令已复制");
  }, [video, toast]);

  // ⌘K 命令面板
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 播放快捷键
  const a = () => artRef.current;
  useHotkeys({
    " ": () => {
      const v = a()?.video as HTMLVideoElement | undefined;
      if (v) (v.paused ? v.play() : v.pause());
    },
    k: () => {
      const v = a()?.video as HTMLVideoElement | undefined;
      if (v) (v.paused ? v.play() : v.pause());
    },
    ArrowRight: () => { const v = a()?.video; if (v) v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5); },
    ArrowLeft: () => { const v = a()?.video; if (v) v.currentTime = Math.max(0, v.currentTime - 5); },
    l: () => { const v = a()?.video; if (v) v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); },
    j: () => { const v = a()?.video; if (v) v.currentTime = Math.max(0, v.currentTime - 10); },
    ArrowUp: (e) => { e.preventDefault(); const v = a()?.video; if (v) v.volume = Math.min(1, v.volume + 0.1); },
    ArrowDown: (e) => { e.preventDefault(); const v = a()?.video; if (v) v.volume = Math.max(0, v.volume - 0.1); },
    "]": () => { const p = a(); if (p) p.playbackRate = Math.min(3, (p.playbackRate || 1) + 0.25); },
    "[": () => { const p = a(); if (p) p.playbackRate = Math.max(0.5, (p.playbackRate || 1) - 0.25); },
    m: () => { const p = a(); if (p) p.muted = !p.muted; },
    f: () => { const p = a(); if (p) p.fullscreen = !p.fullscreen; },
    n: () => next && course && selectVideo(next, course),
    p: () => prev && course && selectVideo(prev, course),
    c: () => copyDownload(),
    b: () => {
      const v = a()?.video; if (v && video) { void apiAddNote(video.videoId, Math.floor(v.currentTime), "书签"); toast("已记书签"); }
    },
    "?": () => setScOpen(true),
    ...Object.fromEntries(
      "0123456789".split("").map((d) => [d, () => { const v = a()?.video; if (v && v.duration) v.currentTime = (Number(d) / 10) * v.duration; }])
    ),
  });

  const sidebar = (
    <CourseSidebar
      courses={courses}
      loading={isLoading}
      activeVideoId={sel?.videoId ?? null}
      activeCourseId={sel?.courseId ?? last?.productId ?? null}
      onSelect={selectVideo}
      onJumpToCurrent={() => {
        if (!sel && last) resume(last.productId, last.videoId);
      }}
    />
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <AppTopBar onMenu={() => setDrawer(true)} onCommand={() => setCmdOpen(true)} />
      {coursesError && !courses.length && !isLoading && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          action={
            <Button
              color="inherit"
              size="small"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await refreshCatalog();
                  window.location.reload();
                } catch {
                  toast("刷新失败，请检查 req.txt 与网关", { severity: "error" });
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? "刷新中…" : "刷新目录"}
            </Button>
          }
        >
          目录加载失败 —— req.txt 会话可能已过期。重新抓一条请求覆盖 req.txt 后点「刷新目录」。
        </Alert>
      )}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box
          sx={{
            width: 340,
            flex: "0 0 auto",
            display: { xs: "none", md: "block" },
            borderRight: (t) => `1px solid ${t.palette.divider}`,
            bgcolor: "md3.surfaceContainerLow",
          }}
        >
          {sidebar}
        </Box>
        <Drawer open={drawer} onClose={() => setDrawer(false)} PaperProps={{ sx: { width: 320 } }}>
          {sidebar}
        </Drawer>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          <ThemeProvider theme={accentTheme}>
            <Box sx={{ p: { xs: 1.5, md: 3 }, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <ContinueWatchingRail onResume={resume} />
              <Box sx={{ width: "100%", maxWidth: 1100 }}>
                <Box
                  sx={{
                    position: "relative",
                    width: "100%",
                    aspectRatio: "16/9",
                    bgcolor: "#000",
                    borderRadius: (t) => t.radius.lg,
                    overflow: "hidden",
                    boxShadow: 6,
                  }}
                >
                  {src ? (
                    <ArtPlayer
                      src={src}
                      thumbnails={thumbnails}
                      startTime={startTime}
                      onTime={onTime}
                      onEnded={() => setUpNext(next)}
                      onInstance={(art) => (artRef.current = art)}
                    />
                  ) : (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "text.secondary",
                        gap: 1,
                      }}
                    >
                      <PlayCircleOutlineRoundedIcon sx={{ fontSize: 56, opacity: 0.5 }} />
                      <Typography variant="body2">{sel ? "加载中…" : "从左侧选择一讲开始播放"}</Typography>
                    </Box>
                  )}
                  <UpNextCountdown
                    next={upNext}
                    onPlay={() => {
                      if (upNext && course) selectVideo(upNext, course);
                      setUpNext(null);
                    }}
                    onCancel={() => setUpNext(null)}
                  />
                </Box>
                {/* 本讲缓存条：已缓存的位置标绿，竖线为预缓存播放头。条宽对齐视频，格子≈时间位置。 */}
                {video && (
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mt: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                      本讲缓存
                    </Typography>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <CacheBar map={segMap} height={10} showPlayhead showLabel />
                    </Box>
                  </Box>
                )}
              </Box>
              {video && course && (
                <PlayerMeta
                  course={course}
                  video={video}
                  hasPrev={!!prev}
                  hasNext={!!next}
                  onPrev={() => prev && selectVideo(prev, course)}
                  onNext={() => next && selectVideo(next, course)}
                  onNotes={() => setNotesOpen(true)}
                  onCopyDownload={copyDownload}
                />
              )}
            </Box>
          </ThemeProvider>
        </Box>
      </Box>

      <NotesPanel
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        videoId={video?.videoId ?? null}
        getCurrentTime={() => artRef.current?.video?.currentTime ?? 0}
        onSeek={(t) => {
          const p = artRef.current;
          if (p) p.currentTime = t;
        }}
      />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} courses={courses} onPick={pickFromPalette} />
      <ShortcutsOverlay open={scOpen} onClose={() => setScOpen(false)} />
    </Box>
  );
}
