"use client";
import useSWR from "swr";
import { useEffect, useRef, useState } from "react";
import { getCourses, getCourseVideos, getCoursesStatus } from "@/lib/api";
import { pickM3u8 } from "@/lib/media";
import type { Course, CoursesStatus, VideoRow } from "@/types/api";

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

export interface BpsSample {
  bps: number;
  series: number[];
}

/** 刚发起控制动作后的「快刷窗口」时长（ms）：动作落地后状态可能正在迁移，
 *  这段时间内强制 1s 刷新，让 UI 立刻看到 暂停/继续/取消/重试 的结果。 */
const RECENT_ACTION_WINDOW_MS = 4000;
// 模块级时间戳：动作处理器调用 markRecentAction() 写入，useCoursesStatus 的轮询谓词读取。
let recentActionAt = 0;

/** 任一缓存控制动作（pause/resume/cancel/retry，含批量提交）发起后调用一次，
 *  让设置页状态轮询在接下来 ~4s 内回到 1s 快刷，避免动作看起来「没反应」。 */
export function markRecentAction(): void {
  recentActionAt = Date.now();
}

/** 设置页：每门课实时状态。忙时 1s、闲时 5s（闲时不停摆，仍低频刷新）。
 *  「忙」= 队列有活 / 有任意非终态任务(working|queued|paused) / 刚发起过控制动作。
 *  另外按相邻两次 bufferBytes 差分出下载速率(bytes/s)，给活动面板做迷你折线。 */
export function useCoursesStatus() {
  const { data, mutate } = useSWR<CoursesStatus>("/api/courses/status", () => getCoursesStatus(), {
    revalidateOnFocus: false,
    keepPreviousData: true,
    dedupingInterval: 800,
    refreshInterval: (d) => {
      if (!d) return 1000;
      // 刚发起动作的快刷窗口内强制 1s，让 暂停/继续/取消/重试 立刻可见。
      if (Date.now() - recentActionAt < RECENT_ACTION_WINDOW_MS) return 1000;
      // 任一非终态任务(working|queued|paused)都算忙——暂停的任务仍需 1s 刷新，
      // 否则切到 5s 会让它看起来「冻住」。只有全部终态(done/cancelled/error)且队列空才回落 5s。
      const busy =
        d.activity.queue.thumb + d.activity.queue.buffer > 0 ||
        d.tasks.some(
          (t) => t.state === "working" || t.state === "queued" || t.state === "paused",
        );
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
