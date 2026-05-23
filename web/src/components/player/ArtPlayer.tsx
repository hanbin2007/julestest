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
  onInstance?: (art: any | null) => void;
  onReady?: () => void;
}

export default function ArtPlayer({ src, thumbnails, startTime, onEnded, onTime, onInstance, onReady }: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const accent = theme.palette.primary.main as string;
  const cbs = React.useRef({ onEnded, onTime, onInstance, onReady });
  cbs.current = { onEnded, onTime, onInstance, onReady };
  const startRef = React.useRef(startTime);
  startRef.current = startTime;

  React.useEffect(() => {
    let art: any;
    let detach = () => {};
    let cancelled = false;
    let lastSave = 0;

    (async () => {
      const [{ default: Artplayer }, { default: Hls }] = await Promise.all([
        import("artplayer"),
        import("hls.js"),
      ]);
      if (cancelled || !ref.current) return;
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
      cbs.current.onInstance?.(art);
      art.on("ready", () => {
        detach = attachLiveScrub(art);
        const s = startRef.current;
        if (s && s > 3) {
          try {
            art.currentTime = s;
          } catch {
            /* ignore */
          }
        }
        cbs.current.onReady?.();
      });
      art.on("video:ended", () => cbs.current.onEnded?.());
      art.on("video:timeupdate", () => {
        const now = Date.now();
        if (now - lastSave < 3000) return;
        lastSave = now;
        const v = art.video as HTMLVideoElement;
        if (v.duration) cbs.current.onTime?.(v.currentTime, v.duration);
      });
    })();

    return () => {
      cancelled = true;
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
    };
    // 仅在切源 / 缩略图就绪时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, thumbnails?.url]);

  return <div className="art-host" ref={ref} style={{ width: "100%", height: "100%" }} />;
}
