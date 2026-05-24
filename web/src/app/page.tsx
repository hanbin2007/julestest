"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import dynamic from "next/dynamic";
import { useSWRConfig } from "swr";
import { Alert, Box, Button, Drawer, Typography } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import PlayCircleOutlineRoundedIcon from "@mui/icons-material/PlayCircleOutlineRounded";
import AppTopBar from "@/components/common/AppTopBar";
import CourseSidebar from "@/components/sidebar/CourseSidebar";
import PlayerMeta from "@/components/player/PlayerMeta";
import NotesPanel from "@/components/player/NotesPanel";
import UpNextCountdown from "@/components/player/UpNextCountdown";
import AnnotationOverlay from "@/components/annotate/AnnotationOverlay";
import FloatingTools from "@/components/annotate/FloatingTools";
import { useAnnotation, bakeAnnotation, bakeWithServerFrame } from "@/components/annotate/useAnnotation";
import { serializeDoc, parseDoc } from "@/components/annotate/model";
import ChatPanel, { type ChatPrefill, CHAT_WIDTH } from "@/components/chat/ChatPanel";
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
import { play, pickM3u8, postProgress, addNote as apiAddNote, saveNoteSnapshot as apiSaveNoteSnapshot, patchSettings, refreshCatalog } from "@/lib/api";
import { themeForSeed, hashSeed } from "@/lib/color";
import { useProgressMap, useLast, useNotes, usePrefs } from "@/hooks/persist";
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
  const { mutate } = useSWRConfig();
  const { courses, isLoading, error: coursesError } = useCourses();
  const [refreshing, setRefreshing] = React.useState(false);
  // 手动刷新目录:重拉课程列表 + 标记各课讲次待更新(下次打开按需重拉,不清缓存→笔记/进度对应不丢),
  // 再就地重验 SWR(不整页刷新,保留播放状态)。
  const refreshCourses = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const { courses: n } = await refreshCatalog();
      await mutate((key) => typeof key === "string" && key.startsWith("/api/course"));
      toast(`已刷新课程列表（${n} 门）`);
    } catch {
      toast("刷新失败，请检查 req.txt 与网关", { severity: "error" });
    } finally {
      setRefreshing(false);
    }
  }, [mutate, toast]);
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
  const [art, setArt] = React.useState<any>(null); // 渲染用（批注层挂载/门控）
  // 批注 + AI 助教
  const [annotateOpen, setAnnotateOpen] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [annotationText, setAnnotationText] = React.useState("");
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = React.useState<string | null>(null); // 深链 ?annotation=
  const [chatPrefill, setChatPrefill] = React.useState<ChatPrefill | null>(null);
  const [savingAnno, setSavingAnno] = React.useState(false);
  const [splitView, setSplitView] = React.useState(false); // 分屏：播放器左 + 对话右
  const [fsWeb, setFsWeb] = React.useState(false); // ArtPlayer 网页全屏态
  const annotation = useAnnotation();

  const { videos: courseVideos } = useCourseVideos(sel?.courseId ?? null);
  const course: Course | undefined = courses.find((c) => c.id === sel?.courseId);
  const video: Video | undefined = courseVideos.find((v) => v.videoId === sel?.videoId);
  const curList = React.useMemo(() => courseVideos.filter((v) => !v.locked), [courseVideos]);
  const idx = curList.findIndex((v) => v.videoId === sel?.videoId);
  const prev = idx > 0 ? curList[idx - 1] : null;
  const next = idx >= 0 && idx < curList.length - 1 ? curList[idx + 1] : null;
  // 批注存/改笔记复用 useNotes（与笔记抽屉同一 SWR key，自动同步）；productId 用于建笔记时绑课
  const notesApi = useNotes(video?.videoId ?? null, sel?.courseId ?? null);
  // 悬浮工具开关（缺省视为开），持久化到偏好
  const { prefs, setPrefs } = usePrefs();
  const floatTools = prefs.floatTools !== false;

  const thumbnails = useThumbPoll(video ?? null);
  // 本讲逐片缓存：观看/预缓存会持续补片，快一点刷新让缓存条像在“长”。
  const segMaps = useSegmentMaps(video ? [video.videoId] : [], { buckets: 100, refreshInterval: 1500 });
  const segMap = video ? segMaps[String(video.videoId)] : undefined;
  // 深链跳转(/?…&t=)指定的起播位置：优先于续看进度，被播放器消费一次后清空。
  const [seekOverride, setSeekOverride] = React.useState<number | undefined>(undefined);
  const startTime = React.useMemo(
    () => seekOverride ?? (sel ? progressMap[String(sel.videoId)]?.t : undefined),
    [seekOverride, sel, progressMap]
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
    const t = Number(sp.get("t"));
    const an = sp.get("annotation"); // 编辑批注深链
    if (p && v) {
      setSel({ courseId: p, videoId: v });
      if (t > 0) setSeekOverride(t);
      if (an) setPendingEditId(an);
      if (t > 0 || an) {
        // 抹掉一次性参数：可分享的跳转链接不该变成"刷新即丢进度/重入编辑"的链接
        window.history.replaceState(null, "", `/?productId=${p}&videoId=${v}`);
      }
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
    setSeekOverride(undefined);
    setSel({ courseId: c.id, videoId: v.videoId });
    void patchSettings({ last: { productId: c.id, videoId: v.videoId } });
    setDrawer(false);
  }, []);

  const resume = React.useCallback((productId: number, videoId: number) => {
    setSeekOverride(undefined);
    setSel({ courseId: productId, videoId });
  }, []);

  const pickFromPalette = React.useCallback((row: VideoRow) => {
    setSeekOverride(undefined);
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
  // 记笔记时对「没有缩略图的课」抓当前画面作预览（已有雪碧图则返回 null，用雪碧图）。
  const captureSnapshot = (): string | null => {
    if (thumbnails) return null; // 当前讲已有缩略图 → 不重复截图
    const v = a()?.video as HTMLVideoElement | undefined;
    if (!v || v.readyState < 2 || !v.videoWidth) return null;
    try {
      const scale = Math.min(1, 400 / v.videoWidth);
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, w, h);
      return c.toDataURL("image/jpeg", 0.72); // 跨源/MSE 污染会抛错 → null
    } catch {
      return null;
    }
  };

  // ---- 批注 ----
  const pauseVideo = () => {
    const v = artRef.current?.video as HTMLVideoElement | undefined;
    if (v && !v.paused) v.pause();
  };
  const openAnnotateFresh = React.useCallback(() => {
    if (!video) return;
    annotation.load([]);
    setAnnotationText("");
    setEditingNoteId(null);
    setAnnotateOpen(true);
    const v = artRef.current?.video as HTMLVideoElement | undefined;
    if (v && !v.paused) v.pause();
  }, [video, annotation]);

  // 合成图：优先服务端取帧（ffmpeg，解决浏览器 HLS drawImage 黑帧）；失败再退回客户端抓帧。
  const composeImage = React.useCallback(async (): Promise<string | null> => {
    const t = Math.floor(artRef.current?.video?.currentTime ?? 0);
    const server = await bakeWithServerFrame(src, t, annotation.objects);
    if (server) return server;
    return bakeAnnotation(artRef.current?.video, annotation.objects).image;
  }, [src, annotation]);

  const saveAnnotation = React.useCallback(async () => {
    if (!video) return;
    if (annotation.objects.length === 0 && !annotationText.trim()) return;
    const text = annotationText.trim() || "批注";
    setSavingAnno(true);
    try {
      const image = await composeImage();
      const strokesJson = serializeDoc(annotation.objects);
      if (editingNoteId) {
        await notesApi.update(editingNoteId, text, strokesJson, image);
        toast("批注已更新");
      } else {
        const t = Math.floor(artRef.current?.video?.currentTime ?? 0);
        await notesApi.add(t, text, image, strokesJson);
        toast("批注已存入笔记");
      }
      setAnnotateOpen(false);
    } catch (e) {
      toast("保存失败：" + (e as Error).message, { severity: "error" });
    } finally {
      setSavingAnno(false);
    }
  }, [video, annotation, annotationText, editingNoteId, notesApi, toast, composeImage]);

  const askClaude = React.useCallback(async () => {
    if (!video) return;
    setSavingAnno(true);
    try {
      const image = await composeImage();
      setChatPrefill({ text: annotationText.trim() || "请讲解一下这道题的思路。", image: image ?? undefined });
      setAnnotateOpen(false);
      setChatOpen(true);
    } finally {
      setSavingAnno(false);
    }
  }, [video, annotationText, composeImage]);

  // 深链「编辑批注」：等播放器就绪 + 该讲笔记加载后，载入笔迹并进入批注模式
  const annoLoad = annotation.load; // 稳定引用，避免整个 annotation 对象进 deps 引起重跑
  const notesList = notesApi.notes;
  React.useEffect(() => {
    if (!pendingEditId || !art || !video) return;
    const note = notesList.find((n) => n.id === pendingEditId);
    if (!note) return; // 笔记尚未加载，等下一轮
    annoLoad(parseDoc(note.strokes));
    setAnnotationText(note.text === "批注" ? "" : note.text);
    setEditingNoteId(note.id);
    setAnnotateOpen(true);
    pauseVideo();
    setPendingEditId(null);
  }, [pendingEditId, art, video, notesList, annoLoad]);

  // ---- 分屏（边看边聊）----
  // 监听 ArtPlayer 网页全屏态
  React.useEffect(() => {
    if (!art) return;
    const on = (s: boolean) => setFsWeb(s);
    try {
      art.on("fullscreenWeb", on);
    } catch {
      /* ignore */
    }
    return () => {
      try {
        art.off("fullscreenWeb", on);
      } catch {
        /* ignore */
      }
    };
  }, [art]);
  // 网页全屏里打开对话 → 自动切到分屏（退出 ArtPlayer 网页全屏，换我们自管的并排布局，
  // 否则对话被播放器的 z-index:9999 盖住看不到）。
  React.useEffect(() => {
    if (chatOpen && fsWeb && !splitView) {
      try {
        if (artRef.current?.fullscreenWeb) artRef.current.fullscreenWeb = false;
      } catch {
        /* ignore */
      }
      setSplitView(true);
    }
  }, [chatOpen, fsWeb, splitView]);
  const toggleSplit = React.useCallback(() => {
    setSplitView((v) => {
      const next = !v;
      if (next) {
        setChatOpen(true);
        try {
          if (artRef.current?.fullscreenWeb) artRef.current.fullscreenWeb = false;
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, []);
  const closeChat = React.useCallback(() => {
    setChatOpen(false);
    setSplitView(false);
  }, []);

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
    a: () => (annotateOpen ? setAnnotateOpen(false) : openAnnotateFresh()),
    n: () => next && course && selectVideo(next, course),
    p: () => prev && course && selectVideo(prev, course),
    c: () => copyDownload(),
    b: () => {
      const v = a()?.video;
      if (v && video) {
        const snap = captureSnapshot();
        void apiAddNote(video.videoId, sel?.courseId ?? null, Math.floor(v.currentTime), "书签").then((r) => {
          if (snap && r.note) void apiSaveNoteSnapshot(r.note.id, snap);
        });
        toast("已记书签");
      }
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
      activeVideoId={sel?.videoId ?? last?.videoId ?? null}
      activeCourseId={sel?.courseId ?? last?.productId ?? null}
      onSelect={selectVideo}
      onJumpToCurrent={() => {
        if (!sel && last) resume(last.productId, last.videoId);
      }}
      onRefresh={refreshCourses}
      refreshing={refreshing}
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
                    // 分屏：播放器变成左侧固定窗格（不重挂 ArtPlayer，避免视频重载）
                    ...(splitView && {
                      position: "fixed",
                      top: 0,
                      left: 0,
                      right: `${CHAT_WIDTH}px`,
                      bottom: 0,
                      width: "auto",
                      height: "auto",
                      aspectRatio: "auto",
                      borderRadius: 0,
                      boxShadow: "none",
                      zIndex: 1300,
                    }),
                  }}
                >
                  {src ? (
                    <ArtPlayer
                      src={src}
                      thumbnails={thumbnails}
                      startTime={startTime}
                      onTime={onTime}
                      onEnded={() => setUpNext(next)}
                      onInstance={(inst) => {
                        artRef.current = inst;
                        setArt(inst);
                        if (!inst) setAnnotateOpen(false);
                      }}
                      onReady={() => setSeekOverride(undefined)}
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
                  onAnnotate={openAnnotateFresh}
                  onChat={() => setChatOpen(true)}
                  onCopyDownload={copyDownload}
                  floatTools={floatTools}
                  onToggleFloat={(v) => void setPrefs({ floatTools: v })}
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
        productId={sel?.courseId ?? null}
        getCurrentTime={() => artRef.current?.video?.currentTime ?? 0}
        getSnapshot={captureSnapshot}
        onSeek={(t) => {
          setSeekOverride(undefined);
          const p = artRef.current;
          if (p) p.currentTime = t;
        }}
      />
      <FloatingTools
        art={art}
        visible={floatTools && !!video && !annotateOpen}
        onAnnotate={openAnnotateFresh}
        onChat={() => setChatOpen(true)}
      />
      {annotateOpen && art && video && (
        <AnnotationOverlay
          art={art}
          api={annotation}
          text={annotationText}
          setText={setAnnotationText}
          onSaveNote={saveAnnotation}
          onAskClaude={askClaude}
          onClose={() => setAnnotateOpen(false)}
          busy={savingAnno}
        />
      )}
      <ChatPanel
        open={chatOpen}
        onClose={closeChat}
        videoId={video?.videoId ?? null}
        productId={sel?.courseId ?? null}
        prefill={chatPrefill}
        onConsumePrefill={() => setChatPrefill(null)}
        split={splitView}
        onToggleSplit={toggleSplit}
        onSaveNote={async (text) => {
          const t = Math.floor(artRef.current?.video?.currentTime ?? 0);
          try {
            await notesApi.add(t, text);
            toast("AI 问答已存入笔记");
          } catch (e) {
            toast("保存失败：" + (e as Error).message, { severity: "error" });
          }
        }}
      />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} courses={courses} onPick={pickFromPalette} />
      <ShortcutsOverlay open={scOpen} onClose={() => setScOpen(false)} />
    </Box>
  );
}
