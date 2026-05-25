"use client";
import useSWR from "swr";
import { getSegmentMaps } from "@/lib/api";
import type { SegmentMap } from "@/types/api";

/** 轮询一批讲次的逐片缓存 bitmap。看课页传单讲、设置页详情抽屉传整门课。
 *  缓存会随观看/预缓存/缓冲增长，故持续刷新；无 vid 时不发请求。 */
export function useSegmentMaps(
  vids: number[],
  { buckets = 60, refreshInterval = 2500 }: { buckets?: number; refreshInterval?: number } = {},
): Record<string, SegmentMap> {
  const sorted = [...vids].sort((a, b) => a - b);
  const key = sorted.length ? `segments:${sorted.join(",")}:${buckets}` : null;
  const { data } = useSWR(
    key,
    () => getSegmentMaps(sorted, buckets),
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 800,
      refreshInterval: (d) => {
        // 所有请求的讲都「已知总数且已缓存满」→ bitmap 不会再增长，停止轮询。
        if (
          d &&
          sorted.every((v) => {
            const m = d.segments[String(v)];
            return m && m.total != null && m.cached >= m.total;
          })
        )
          return 0;
        return refreshInterval; // 仍在增长 / 总数未知 → 维持轮询
      },
    },
  );
  return data?.segments ?? {};
}
