"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import dynamic from "next/dynamic";
import { useSWRConfig } from "swr";
import { Alert, Box, Button, Drawer, Typography } from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { Theme } from "@mui/material/styles";
import { ThemeProvider } from "@mui/material/styles";
import PlayCircleOutlineRoundedIcon from "@mui/icons-material/PlayCircleOutlineRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import AppTopBar from "@/components/common/AppTopBar";
import CourseSidebar from "@/components/sidebar/CourseSidebar";
import SidebarShell from "@/components/sidebar/SidebarShell";
import PlayerMeta from "@/components/player/PlayerMeta";
import NotesPanel, { NOTES_WIDTH } from "@/components/player/NotesPanel";
import TimelineMarkers from "@/components/player/TimelineMarkers";
import NoteViewer from "@/components/notes/NoteViewer";
import UpNextCountdown from "@/components/player/UpNextCountdown";
import AnnotationOverlay from "@/components/annotate/AnnotationOverlay";
import FloatingTools from "@/components/annotate/FloatingTools";
import { useAnnotation, bakeAnnotation, bakeWithServerFrame } from "@/components/annotate/useAnnotation";
import { serializeDoc, parseDoc } from "@/components/annotate/model";
import ChatPanel, { CHAT_WIDTH } from "@/components/chat/ChatPanel";
import type { ChatPrefill } from "@/components/chat/ChatBody";
import * as api from "@/lib/api";
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
import { play, pickM3u8, postProgress, flushProgress, patchSettings, refreshCatalog } from "@/lib/api";
import { themeForSeed, hashSeed } from "@/lib/color";
import { useProgressMap, useLast, useNotes, useAllNotes, usePrefs } from "@/hooks/persist";
import type { Course, Video, VideoRow } from "@/types/api";
import type { EnrichedNote } from "@/lib/store";

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
  const [streamError, setStreamError] = React.useState<Error | null>(null);
  const [retryNonce, setRetryNonce] = React.useState(0);
  const [upNext, setUpNext] = React.useState<Video | null>(null);
  const artRef = React.useRef<any>(null);
  const [art, setArt] = React.useState<any>(null); // 渲染用（批注层挂载/门控）
  // 批注 + AI 助教
  const [annotateOpen, setAnnotateOpen] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  // 多聊天:activeChatId 是当前在 ChatPanel 里显示的那条;null = 未选/新建空白。
  // 关闭面板不清 — 再开还是同一条;切讲时也不清 — 同一条聊天可跨讲继续。
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const [annotationText, setAnnotationText] = React.useState("");
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = React.useState<string | null>(null); // 深链 ?annotation=
  const [pendingChatId, setPendingChatId] = React.useState<string | null>(null); // 深链 ?chat=
  const [chatPrefill, setChatPrefill] = React.useState<ChatPrefill | null>(null);
  const [savingAnno, setSavingAnno] = React.useState(false);
  // 分屏：播放器左 + 右侧面板（对话 / 笔记，二选一互斥）。null = 无分屏。
  const [activeSidePanel, setActiveSidePanel] = React.useState<"chat" | "notes" | null>(null);
  const [previewNote, setPreviewNote] = React.useState<EnrichedNote | null>(null); // 组合预览弹窗
  const [fsWeb, setFsWeb] = React.useState(false); // ArtPlayer 网页全屏态
  const annotation = useAnnotation();
  const chatSplit = activeSidePanel === "chat";
  const notesSplit = activeSidePanel === "notes";
  const sidePanelWidth = activeSidePanel === "chat" ? CHAT_WIDTH : activeSidePanel === "notes" ? NOTES_WIDTH : 0;

  const { videos: courseVideos } = useCourseVideos(sel?.courseId ?? null);
  const course: Course | undefined = courses.find((c) => c.id === sel?.courseId);
  const video: Video | undefined = courseVideos.find((v) => v.videoId === sel?.videoId);
  const curList = React.useMemo(() => courseVideos.filter((v) => !v.locked), [courseVideos]);
  const idx = curList.findIndex((v) => v.videoId === sel?.videoId);
  const prev = idx > 0 ? curList[idx - 1] : null;
  const next = idx >= 0 && idx < curList.length - 1 ? curList[idx + 1] : null;
  // 批注存/改笔记复用 useNotes（与笔记抽屉同一 SWR key，自动同步）；productId 用于建笔记时绑课
  const notesApi = useNotes(video?.videoId ?? null, sel?.courseId ?? null);
  // 富化全量笔记：供时间轴打点（本讲）+ 组合预览弹窗用（带 hasSnap/缩略图）。
  const { notes: allNotes } = useAllNotes();
  const currentLessonNotes = React.useMemo(
    () => allNotes.filter((n) => n.videoId === sel?.videoId && n.courseId === sel?.courseId),
    [allNotes, sel]
  );
  // 悬浮工具开关（缺省视为开），持久化到偏好
  const { prefs, setPrefs } = usePrefs();
  const floatTools = prefs.floatTools !== false;
  // 课程侧栏折叠态（桌面） & 视口断点：☰ 在桌面切折叠、在移动端开抽屉。
  const sidebarCollapsed = !!prefs.sidebarCollapsed;
  const isMdUp = useMediaQuery((t: Theme) => t.breakpoints.up("md"));

  const thumbnails = useThumbPoll(video ?? null);
  // 本讲逐片缓存：观看/预缓存会持续补片，快一点刷新让缓存条像在“长”。
  const segMaps = useSegmentMaps(video ? [video.videoId] : [], { buckets: 100, refreshInterval: 1500 });
  const segMap = video ? segMaps[String(video.videoId)] : undefined;
  // 深链跳转(/?…&t=)指定的起播位置：优先于续看进度，被播放器消费一次后清空。
  const [seekOverride, setSeekOverride] = React.useState<number | undefined>(undefined);
  const startTime = React.useMemo(
    () => seekOverride ?? (sel ? progressMap[`${sel.courseId}:${sel.videoId}`]?.t : undefined),
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
    const ch = sp.get("chat"); // 指定打开某个 chat(从 /chats 跳进来)
    if (p && v) {
      setSel({ courseId: p, videoId: v });
      if (t > 0) setSeekOverride(t);
      if (an) setPendingEditId(an);
      if (ch) {
        setPendingChatId(ch);
        setActiveChatId(ch);
        setChatOpen(true);
      }
      if (t > 0 || an || ch) {
        // 抹掉一次性参数:可分享的跳转链接不该变成"刷新即丢进度/重入编辑/重开聊天"的链接
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

  // 默认聊天解析:面板开 + activeChatId 为空 → 拉本讲 chat 列表,挑最近一条;空则保留 null(懒建)。
  // 注意 sel 不在 deps — 换讲不能重置 activeChatId(req: 跨讲不再打断聊天)。
  React.useEffect(() => {
    if (!chatOpen || activeChatId || !sel) return;
    let cancelled = false;
    api
      .getChats({ scope: "lesson", productId: sel.courseId, videoId: sel.videoId })
      .then((r) => {
        if (cancelled) return;
        if (r.chats[0]) setActiveChatId(r.chats[0].id);
      })
      .catch(() => {/* 拉失败保留 null,首条消息会触发新建 */});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, activeChatId]);

  // 取流
  React.useEffect(() => {
    setSrc(null);
    setUpNext(null);
    setStreamError(null);
    if (!video) return;
    const m = pickM3u8(video);
    if (!m) {
      toast("该讲暂无可播放地址（可能未解锁）", { severity: "warning" });
      return;
    }
    let cancelled = false;
    play(video, m)
      .then((r) => !cancelled && setSrc(r.url))
      .catch((e) => {
        if (cancelled) return;
        setStreamError(e as Error);
        toast("取流失败：" + (e as Error).message, { severity: "error" });
      });
    return () => {
      cancelled = true;
    };
    // videoId 跨产品可复用：加 productId 维度，切到同 videoId 的另一产品时重新取流。
    // retryNonce 入依赖：「重试取流」自增它即可重跑本 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.videoId, video?.productId, retryNonce]);

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

  // 关闭页 / 切后台 / 切讲时的最后位置上报（sendBeacon/keepalive，卸载也能送达）。
  const onFlush = React.useCallback(
    (t: number, d: number) => {
      if (!video || !course) return;
      flushProgress(video.videoId, t, d, {
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
      setNotesOpen(false); // 与笔记面板互斥
      setActiveSidePanel((cur) => (cur === "notes" ? null : cur));
      setChatOpen(true); // 若处于网页全屏，下面的 effect 会自动切成对话分屏
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
  const exitWebFs = () => {
    try {
      if (artRef.current?.fullscreenWeb) artRef.current.fullscreenWeb = false;
    } catch {
      /* ignore */
    }
  };
  // 进分屏时若是从「网页全屏」退出来的，记一笔；关闭分屏时据此把网页全屏还原回去
  // （否则用户从全屏开面板、关掉后会被丢回普通窗口态——这正是要修的 bug）。
  const restoreFsWebRef = React.useRef(false);
  const restoreFsWebIfNeeded = React.useCallback(() => {
    if (!restoreFsWebRef.current) return;
    restoreFsWebRef.current = false;
    try {
      const p = artRef.current;
      if (p && !p.fullscreenWeb) p.fullscreenWeb = true;
    } catch {
      /* ignore */
    }
  }, []);
  // 打开对话/笔记面板：两者互斥（开一个关另一个）。已在分屏 → 直接切到另一面板（保持分屏+还原标记）；
  // 网页全屏里 → 进分屏（退出 ArtPlayer 网页全屏，否则被 z-index:9999 盖住，并记下要还原）；
  // 否则普通态走 Drawer。
  const openPanel = React.useCallback(
    (kind: "chat" | "notes") => {
      setChatOpen(kind === "chat");
      setNotesOpen(kind === "notes");
      if (activeSidePanel) {
        setActiveSidePanel(kind); // 分屏内换面板，保留 restoreFsWebRef
      } else if (fsWeb) {
        restoreFsWebRef.current = true;
        exitWebFs();
        setActiveSidePanel(kind);
      } else {
        restoreFsWebRef.current = false;
        setActiveSidePanel(null); // 抽屉
      }
    },
    [fsWeb, activeSidePanel]
  );
  // 显式进分屏（面板头部「分屏」按钮）：记下当前是否网页全屏（抽屉态一般为否），再切成并排窗格。
  const enterSplit = React.useCallback((kind: "chat" | "notes") => {
    restoreFsWebRef.current = !!artRef.current?.fullscreenWeb;
    setChatOpen(kind === "chat");
    setNotesOpen(kind === "notes");
    exitWebFs();
    setActiveSidePanel(kind);
  }, []);
  // 网页全屏里打开对话 → 自动切到分屏（覆盖「先开对话抽屉再进网页全屏」的边角）。
  React.useEffect(() => {
    if (chatOpen && fsWeb && activeSidePanel !== "chat") {
      restoreFsWebRef.current = true;
      setNotesOpen(false);
      exitWebFs();
      setActiveSidePanel("chat");
    }
  }, [chatOpen, fsWeb, activeSidePanel]);

  const openChat = React.useCallback(() => openPanel("chat"), [openPanel]);
  const openNotes = React.useCallback(() => openPanel("notes"), [openPanel]);
  // 分屏头部「退出分屏」= 转抽屉态（窗口态）：用户主动选窗口，取消「还原全屏」的待办。
  const toggleSplit = React.useCallback(() => {
    if (activeSidePanel === "chat") {
      restoreFsWebRef.current = false;
      setActiveSidePanel(null);
    } else enterSplit("chat");
  }, [activeSidePanel, enterSplit]);
  const toggleNotesSplit = React.useCallback(() => {
    if (activeSidePanel === "notes") {
      restoreFsWebRef.current = false;
      setActiveSidePanel(null);
    } else enterSplit("notes");
  }, [activeSidePanel, enterSplit]);
  // 关闭面板：若当前是分屏（而非抽屉），关闭后还原进分屏前的网页全屏。
  const closeChat = React.useCallback(() => {
    setChatOpen(false);
    if (activeSidePanel === "chat") {
      setActiveSidePanel(null);
      restoreFsWebIfNeeded();
    }
  }, [activeSidePanel, restoreFsWebIfNeeded]);
  const closeNotes = React.useCallback(() => {
    setNotesOpen(false);
    if (activeSidePanel === "notes") {
      setActiveSidePanel(null);
      restoreFsWebIfNeeded();
    }
  }, [activeSidePanel, restoreFsWebIfNeeded]);

  // 笔记跳转：同讲只 seek；跨讲原地切讲 + 定位（保持分屏布局，视频重新取流）。
  const jumpToNote = React.useCallback(
    (cid: number, vid: number, t: number) => {
      if (cid === sel?.courseId && vid === sel?.videoId) {
        const p = artRef.current;
        if (p?.video) p.currentTime = t;
      } else {
        setSeekOverride(t);
        setSel({ courseId: cid, videoId: vid });
        void patchSettings({ last: { productId: cid, videoId: vid } });
      }
    },
    [sel]
  );
  // 从面板编辑批注：切到该讲（同讲不重载）+ 进批注模式（pendingEditId 待笔记加载后载入笔迹）。腾出整屏。
  const editAnnotationFromPanel = React.useCallback(
    (cid: number, vid: number, t: number, id: string) => {
      if (cid !== sel?.courseId || vid !== sel?.videoId) {
        setSeekOverride(t); // 跨讲：新流就绪后由 startTime 定位到该时刻
        setSel({ courseId: cid, videoId: vid });
        void patchSettings({ last: { productId: cid, videoId: vid } });
      } else {
        const p = artRef.current; // 同讲：直接 seek 到批注那一刻，看到原帧再改
        if (p?.video) p.currentTime = t;
      }
      setPendingEditId(id);
      setNotesOpen(false);
      restoreFsWebRef.current = false; // 批注要整屏窗口态，不还原网页全屏
      setActiveSidePanel(null);
    },
    [sel]
  );
  // 面板「记到本讲」：当前讲当前时刻 + 截图（notesApi.add 会顺带重验统一管理 key）。
  const addNoteHere = React.useCallback(
    (text: string) => {
      const v = artRef.current?.video as HTMLVideoElement | undefined;
      if (!video || !v) return;
      void notesApi.add(Math.floor(v.currentTime), text, captureSnapshot());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [video, notesApi]
  );

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
        // 走 notesApi.add：附带截图 + 同步重验单讲/统一管理两个 SWR key（抽屉/分屏/打点即时刷新）
        void notesApi.add(Math.floor(v.currentTime), "书签", captureSnapshot());
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
      <AppTopBar
        onMenu={() => {
          // 桌面端 ☰ = 折叠 / 展开课程侧栏；移动端 ☰ = 打开抽屉。
          if (isMdUp) void setPrefs({ sidebarCollapsed: !sidebarCollapsed });
          else setDrawer(true);
        }}
        menuTooltip={isMdUp ? (sidebarCollapsed ? "展开课程列表" : "折叠课程列表") : "目录"}
        onCommand={() => setCmdOpen(true)}
        context={
          video && course
            ? `${course.name} › ${video.title ?? `视频 ${video.videoId}`}`
            : undefined
        }
      />
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
        <SidebarShell>{sidebar}</SidebarShell>
        <Drawer open={drawer} onClose={() => setDrawer(false)} PaperProps={{ sx: { width: 320 } }}>
          {sidebar}
        </Drawer>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          <ThemeProvider theme={accentTheme}>
            <Box sx={{ p: { xs: 1.5, md: 3 }, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <ContinueWatchingRail onResume={resume} />
              {/* 播放器+缓存条整体不可选中：iOS Safari 点/长按播放器会选中包裹盒成大蓝块 */}
              <Box sx={{ width: "100%", maxWidth: 1100, userSelect: "none", WebkitUserSelect: "none" }}>
                <Box
                  sx={{
                    position: "relative",
                    width: "100%",
                    aspectRatio: "16/9",
                    bgcolor: "#000",
                    borderRadius: (t) => t.radius.lg,
                    overflow: "hidden",
                    boxShadow: 6,
                    // 分屏：播放器变成左侧固定窗格（不重挂 ArtPlayer，避免视频重载）。
                    // 右偏移按当前激活的面板宽度（对话 / 笔记）。
                    ...(activeSidePanel && {
                      position: "fixed",
                      top: 0,
                      left: 0,
                      right: `${sidePanelWidth}px`,
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
                      onFlush={onFlush}
                      onEnded={() => setUpNext(next)}
                      onInstance={(inst) => {
                        artRef.current = inst;
                        setArt(inst);
                        if (!inst) setAnnotateOpen(false);
                      }}
                      onReady={() => setSeekOverride(undefined)}
                    />
                  ) : sel && streamError ? (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "text.secondary",
                        gap: 1.5,
                        px: 2,
                        textAlign: "center",
                      }}
                    >
                      <ErrorOutlineRoundedIcon sx={{ fontSize: 56, color: "error.main", opacity: 0.85 }} />
                      <Typography variant="body2">取流失败</Typography>
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => {
                          setStreamError(null);
                          setRetryNonce((n) => n + 1);
                        }}
                      >
                        重试取流
                      </Button>
                    </Box>
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
                  onNotes={openNotes}
                  onAnnotate={openAnnotateFresh}
                  onChat={openChat}
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
        onClose={closeNotes}
        split={notesSplit}
        onToggleSplit={toggleNotesSplit}
        currentVideoId={video?.videoId ?? null}
        currentCourseId={sel?.courseId ?? null}
        onAddNote={addNoteHere}
        onJump={jumpToNote}
        onPreview={(n) => setPreviewNote(n)}
        onEditAnnotation={editAnnotationFromPanel}
      />
      {/* 时间轴打点：本讲笔记处打点，悬浮预览、点击跳转（挂进播放器进度条，全屏也在） */}
      {art && video && (
        <TimelineMarkers
          art={art}
          notes={currentLessonNotes}
          accent={course ? hashSeed(course.name) : undefined}
          onSeek={(t) => {
            const p = artRef.current;
            if (p?.video) p.currentTime = t;
          }}
          onPreview={(n) => setPreviewNote(n)}
        />
      )}
      <FloatingTools
        art={art}
        visible={floatTools && !!video && !annotateOpen}
        onNotes={openNotes}
        onAnnotate={openAnnotateFresh}
        onChat={openChat}
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
        chatId={activeChatId}
        onChangeChatId={setActiveChatId}
        getCurrentLesson={() =>
          sel && video ? { productId: sel.courseId, videoId: video.videoId } : null
        }
        prefill={chatPrefill}
        onConsumePrefill={() => setChatPrefill(null)}
        split={chatSplit}
        onToggleSplit={toggleSplit}
        getVideoTime={() => artRef.current?.video?.currentTime ?? 0}
        onSaveNote={async (text, videoT) => {
          // 锚到「提问那一刻」：videoT 来自该问答；缺省退回当前播放位置
          const t = videoT ?? Math.floor(artRef.current?.video?.currentTime ?? 0);
          try {
            // 截图取那一刻的画面：服务端 ffmpeg 取帧（解决 HLS 黑帧），失败再退回当前画面抓帧
            const snap = (await bakeWithServerFrame(src, t, [])) ?? captureSnapshot();
            await notesApi.add(t, text, snap);
            toast("AI 问答已存入笔记");
          } catch (e) {
            toast("保存失败：" + (e as Error).message, { severity: "error" });
          }
        }}
      />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} courses={courses} onPick={pickFromPalette} />
      <ShortcutsOverlay open={scOpen} onClose={() => setScOpen(false)} />
      {/* 组合预览弹窗：截图 + 文字（Markdown/LaTeX）+ 跳转/编辑批注 */}
      <NoteViewer
        note={previewNote}
        open={!!previewNote}
        onClose={() => setPreviewNote(null)}
        onJump={(cid, vid, t) => {
          setPreviewNote(null);
          jumpToNote(cid, vid, t);
        }}
        onEditAnnotation={(cid, vid, t, id) => {
          setPreviewNote(null);
          editAnnotationFromPanel(cid, vid, t, id);
        }}
      />
    </Box>
  );
}
