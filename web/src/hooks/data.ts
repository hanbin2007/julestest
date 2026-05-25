"use client";
import useSWR from "swr";
import { useEffect, useRef, useState } from "react";
import { getCourses, getCourseVideos, getStatus, getCoursesStatus } from "@/lib/api";
import { pickM3u8 } from "@/lib/media";
import type { Course, CoursesStatus, StatusResponse, VideoRow } from "@/types/api";

export function useCourses() {
  const { data, error, isLoading } = useSWR("/api/courses", () => getCourses(), {
    revalidateOnFocus: false,
  });
  return { courses: data?.courses ?? [], error: error as Error | undefined, isLoading };
}

export function useCourseVideos(productId: number | null) {
  const key = productId ? `/api/course?productId=${productId}` : null;
  const { data, error, isLoading } = useSWR(key, () => getCourseVideos(productId as number), {
    revalidateOnFocus: false,
  });
  return { videos: data?.videos ?? [], error: error as Error | undefined, isLoading };
}

/** 顺序加载所有课程的视频，拍平成单集行（设置页/命令面板）。StrictMode 安全。 */
export function useAllCourseVideos(courses: Course[]) {
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [loaded, setLoaded] = useState(0);
  // 仅当课程集合（按 id）真正变化时重新拉取，避免数组 identity 抖动触发全量重取。
  const key = courses.map((c) => c.id).sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (!courses.length) return;
    let cancelled = false;
    setRows([]);
    setLoaded(0);
    (async () => {
      const acc: VideoRow[] = [];
      for (const c of courses) {
        if (cancelled) return; // 卸载/重挂前先退出，避免对未挂载组件 setState
        try {
          const { videos } = await getCourseVideos(c.id);
          videos
            .filter((v) => !v.locked && pickM3u8(v)) // pickM3u8 含直播回放(downloadUrl 兜底)
            .forEach((v) => acc.push({ v, courseId: c.id, courseName: c.name }));
        } catch {
          /* skip */
        }
        if (cancelled) return;
        setRows([...acc]);
        setLoaded((x) => x + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { rows, loaded, total: courses.length, done: courses.length > 0 && loaded >= courses.length };
}

export function useStatus(active: boolean) {
  const { data, mutate } = useSWR<StatusResponse>("/api/status", () => getStatus(), {
    revalidateOnFocus: false,
    refreshInterval: (d) => {
      if (!active) return 0;
      const busy = d
        ? d.thumb.queued + d.thumb.generating.length + d.buffer.queued + d.buffer.working.length > 0
        : true;
      return busy ? 1500 : 0;
    },
  });
  return { status: data, refresh: mutate };
}

export interface BpsSample {
  bps: number;
  series: number[];
}

/** 设置页：每门课实时状态。忙时 1s、闲时 5s（不再像 useStatus 那样闲时停摆）。
 *  另外按相邻两次 bufferBytes 差分出下载速率(bytes/s)，给活动面板做迷你折线。 */
export function useCoursesStatus() {
  const { data, mutate } = useSWR<CoursesStatus>("/api/courses/status", () => getCoursesStatus(), {
    revalidateOnFocus: false,
    keepPreviousData: true,
    dedupingInterval: 800,
    refreshInterval: (d) => {
      if (!d) return 1000;
      // 仅「真正在跑」的任务算忙；纯暂停的稳态回落到 5s（暂停不消耗、无需 1s 刷新）。
      const busy =
        d.activity.queue.thumb + d.activity.queue.buffer > 0 ||
        d.tasks.some((t) => t.state === "working");
      return busy ? 1000 : 5000;
    },
  });

  // 客户端差分速率（服务端无状态，不在路由里算）
  const prev = useRef<{ bytes: number; at: number } | null>(null);
  const [bps, setBps] = useState<BpsSample>({ bps: 0, series: [] });
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const bytes = data.totals.bufferBytes;
    const p = prev.current;
    prev.current = { bytes, at: now };
    if (!p) return;
    const dt = (now - p.at) / 1000;
    if (dt <= 0) return;
    const rate = Math.max(0, (bytes - p.bytes) / dt);
    setBps((s) => ({ bps: rate, series: [...s.series, rate].slice(-30) }));
  }, [data]);

  return { data, refresh: mutate, bps };
}
