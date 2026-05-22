"use client";
import { useEffect, useState } from "react";
import { getThumb } from "@/lib/api";
import { pickLow } from "@/lib/media";
import type { Video } from "@/types/api";

export interface ThumbOpt {
  url: string;
  number: number;
  column: number;
  width: number;
  height: number;
}

/** 轮询 /api/thumb 直到该讲缩略图就绪；切讲自动取消。 */
export function useThumbPoll(video: Video | null): ThumbOpt | null {
  const [thumb, setThumb] = useState<ThumbOpt | null>(null);
  const vid = video?.videoId;
  useEffect(() => {
    setThumb(null);
    if (!video) return;
    const low = pickLow(video);
    if (!low) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await getThumb(video, low);
        if (cancelled) return;
        if (r.state === "ready") {
          const { url, number, column, width, height } = r;
          setThumb({ url, number, column, width, height });
          return;
        }
        if (r.state === "error") return;
      } catch {
        /* retry */
      }
      if (++tries < 90 && !cancelled) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vid]);
  return thumb;
}
