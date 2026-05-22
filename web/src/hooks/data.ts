"use client";
import useSWR from "swr";
import { useEffect, useRef, useState } from "react";
import { getCourses, getCourseVideos, getStatus } from "@/lib/api";
import { pickLow } from "@/lib/media";
import type { Course, StatusResponse, VideoRow } from "@/types/api";

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

/** 顺序加载所有课程的视频，拍平成单集行（设置页/命令面板）。 */
export function useAllCourseVideos(courses: Course[]) {
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [loaded, setLoaded] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    if (!courses.length || started.current) return;
    started.current = true;
    let cancelled = false;
    (async () => {
      const acc: VideoRow[] = [];
      for (const c of courses) {
        try {
          const { videos } = await getCourseVideos(c.id);
          videos
            .filter((v) => !v.locked && pickLow(v))
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
  }, [courses]);
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
