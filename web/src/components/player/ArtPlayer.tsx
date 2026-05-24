"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import { useTheme } from "@mui/material/styles";
import { HLS_CONFIG } from "@/lib/hls-config";
import { attachLiveScrub } from "./useLiveScrub";
import type { ThumbOpt } from "@/hooks/useThumbPoll";

interface Props {
  src: string;
  thumbnails: ThumbOpt | null;
  startTime?: number;
  onEnded?: () => void;
  onTime?: (t: number, d: number) => void;
  onFlush?: (t: number, d: number) => void;
  onInstance?: (art: any | null) => void;
  onReady?: () => void;
}

export default function ArtPlayer({ src, thumbnails, startTime, onEnded, onTime, onFlush, onInstance, onReady }: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const accent = theme.palette.primary.main as string;
  const cbs = React.useRef({ onEnded, onTime, onInstance, onReady });
  cbs.current = { onEnded, onTime, onInstance, onReady };
  const startRef = React.useRef(startTime);
  startRef.current = startTime;

  // 续看 / 保存的生命周期标记（均按「每个播放器实例」重置）：
  const artInstRef = React.useRef<any>(null); // 当前实例（供事件外的逻辑访问）
  const readyRef = React.useRef(false); // ready 是否已触发（可以 seek 了）
  const seekedRef = React.useRef(false); // 本实例是否已执行过续看跳转（去重，防止焦点重验时把用户拽回）
  const restoredRef = React.useRef(false); // 播放位置是否已抵达续看点（到达后才允许如实落库）

  // 续看跳转：仅在「播放器就绪」且「拿到有效续看位置」时执行一次。
  // 续看位置可能晚于 ready 才异步到达（progressMap/SWR 加载慢于播放器就绪），
  // 那一刻 ready 里读到的还是 undefined → 旧逻辑只在 ready 里 seek 一次便永久错过，
  // 这正是「关闭后重开不从上次位置续播」的根因。故此处也由 startTime 变化驱动补做。
  const applyResume = React.useCallback(() => {
    if (seekedRef.current) return;
    const art = artInstRef.current;
    if (!art || !readyRef.current) return;
    const s = startRef.current;
    if (s == null) return; // 位置还没到（异步加载中）→ 等它到达后由下面的 effect 再触发
    seekedRef.current = true;
    if (s > 3) {
      try {
        art.currentTime = s;
      } catch {
        /* ignore */
      }
    }
  }, []);

  // 续看位置异步到达（或变化）时补做一次跳转
  React.useEffect(() => {
    applyResume();
  }, [startTime, applyResume]);

  React.useEffect(() => {
    let art: any;
    let detach = () => {};
    let cancelled = false;
    // 初值用 now：否则首帧 timeupdate（now - 0 远大于 3000）会立即把「刚开播≈0」
    // 的位置写库、覆盖掉真实进度 —— 这是进度被重置成 0 的元凶之一。
    let lastSave = Date.now();
    // 冻结本实例对应的最终保存回调：cbs.current 会随 props 切到下一讲，
    // 卸载时若用它会把「本讲的最后位置」误存到下一讲名下。
    const flush = onFlush;

    // 关闭页 / 切后台 / 切讲时确保最后位置落库（flush 走 sendBeacon/keepalive，卸载后仍能送达）。
    // 续看尚未抵达前不存，避免用「从头自动播放」的早期位置覆盖真实进度。
    const saveFinal = () => {
      const a = artInstRef.current;
      if (!a) return;
      const v = a.video as HTMLVideoElement | undefined;
      if (!v || !v.duration || v.currentTime <= 0) return;
      const s = startRef.current;
      if (s != null && s > 3 && !restoredRef.current && v.currentTime < s - 3) return;
      flush?.(v.currentTime, v.duration);
    };
    const onVisHide = () => {
      if (document.visibilityState === "hidden") saveFinal();
    };

    (async () => {
      const [{ default: Artplayer }, { default: Hls }] = await Promise.all([
        import("artplayer"),
        import("hls.js"),
      ]);
      if (cancelled || !ref.current) return;
      // 本实例生命周期标记复位：必须在创建实例前，且不能只靠外层 cleanup ——
      // 同一讲因缩略图就绪而重建时，残留的 seekedRef 会吞掉新一轮续看。
      readyRef.current = false;
      seekedRef.current = false;
      restoredRef.current = false;
      // 长按快进：artplayer 默认 1000ms 触发偏长，缩短让长按更跟手
      (Artplayer as any).FAST_FORWARD_TIME = 500;
      art = new Artplayer({
        container: ref.current,
        url: src,
        type: "m3u8",
        autoplay: true,
        theme: accent,
        volume: 1,
        playbackRate: true,
        setting: true,
        fullscreen: true,
        fullscreenWeb: true,
        pip: true,
        miniProgressBar: true,
        fastForward: true,
        autoOrientation: true,
        playsInline: true,
        hotkey: false,
        lock: true,
        moreVideoAttr: { playsInline: true } as any,
        ...(thumbnails
          ? {
              thumbnails: {
                url: thumbnails.url,
                number: thumbnails.number,
                column: thumbnails.column,
                width: thumbnails.width,
                height: thumbnails.height,
              },
            }
          : {}),
        customType: {
          m3u8: (video: HTMLVideoElement, url: string, a: any) => {
            if (Hls.isSupported()) {
              const hls = new Hls(HLS_CONFIG as any);
              hls.loadSource(url);
              hls.attachMedia(video);
              hls.on(Hls.Events.ERROR, (_e: unknown, d: any) => {
                if (!d?.fatal) return;
                if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              });
              a._hls = hls;
            } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = url;
            }
          },
        },
      });
      artInstRef.current = art;
      cbs.current.onInstance?.(art);
      art.on("ready", () => {
        readyRef.current = true;
        detach = attachLiveScrub(art);
        applyResume();
        cbs.current.onReady?.();
      });
      art.on("video:ended", () => cbs.current.onEnded?.());
      art.on("video:timeupdate", () => {
        const v = art.video as HTMLVideoElement;
        if (!v.duration) return;
        const s = startRef.current;
        // 续看尚未生效（位置还在续看点之前）→ 先别保存，保护数据库里的真实进度；
        // 一旦抵达续看点便标记 restored，之后（含用户主动往回拖）都如实保存。
        if (s != null && s > 3 && !restoredRef.current) {
          if (v.currentTime >= s - 3) restoredRef.current = true;
          else return;
        }
        const now = Date.now();
        if (now - lastSave < 3000) return;
        lastSave = now;
        cbs.current.onTime?.(v.currentTime, v.duration);
      });
      window.addEventListener("pagehide", saveFinal);
      document.addEventListener("visibilitychange", onVisHide);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", saveFinal);
      document.removeEventListener("visibilitychange", onVisHide);
      try {
        saveFinal(); // 切讲 / 卸载时也存最后位置（在销毁实例前，video 仍可读）
      } catch {
        /* ignore */
      }
      cbs.current.onInstance?.(null);
      try {
        detach();
      } catch {
        /* ignore */
      }
      try {
        if (art?._hls) art._hls.destroy();
      } catch {
        /* ignore */
      }
      try {
        art?.destroy(true);
      } catch {
        /* ignore */
      }
      artInstRef.current = null;
      readyRef.current = false;
      seekedRef.current = false;
      restoredRef.current = false;
    };
    // 仅在切源 / 缩略图就绪时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, thumbnails?.url]);

  return <div className="art-host" ref={ref} style={{ width: "100%", height: "100%" }} />;
}
