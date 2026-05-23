import type { Course, Video } from "@/types/api";

export interface SelectFn {
  (video: Video, course: Course): void;
}

export interface GroupNode {
  key: string; // 稳定路径 key，用于受控展开/折叠（精确到小节）
  name: string;
  kids: GroupNode[];
  vids: Video[];
}

// 点播目录按 module > topic > examKey 三层分组；无任何层级的挂在 root。
export function buildTree(videos: Video[]): { root: Video[]; groups: GroupNode[] } {
  const groups: GroupNode[] = [];
  const idx = new Map<string, GroupNode>();
  const root: Video[] = [];
  for (const v of videos) {
    const path = [v.module, v.topic, v.examKey].filter(Boolean) as string[];
    if (!path.length) {
      root.push(v);
      continue;
    }
    let level = groups;
    let key = "";
    let node: GroupNode | undefined;
    for (const p of path) {
      key += "|" + p;
      node = idx.get(key);
      if (!node) {
        node = { key, name: p, kids: [], vids: [] };
        idx.set(key, node);
        level.push(node);
      }
      level = node.kids;
    }
    node!.vids.push(v);
  }
  return { root, groups };
}

// active 视频所在分组的祖先链 key（从外到内）；root 级（无分组）返回 null。
export function pathToVideo(groups: GroupNode[], videoId: number): string[] | null {
  for (const g of groups) {
    if (g.vids.some((v) => v.videoId === videoId)) return [g.key];
    const sub = pathToVideo(g.kids, videoId);
    if (sub) return [g.key, ...sub];
  }
  return null;
}

// 一棵分组树里的全部 key（含各层）。
export function allGroupKeys(groups: GroupNode[], acc: string[] = []): string[] {
  for (const g of groups) {
    acc.push(g.key);
    allGroupKeys(g.kids, acc);
  }
  return acc;
}

// 直播回放分组：有多个分栏(liveTab)时按 分栏 > 年月 两层，否则直接按 年月。
export function buildLiveGroups(videos: Video[]): GroupNode[] {
  const monthName = (v: Video) =>
    v.year && v.month ? `${v.year}年${Number(v.month)}月` : "其他";
  const byMonth = (vids: Video[], prefix: string): GroupNode[] => {
    const map = new Map<string, GroupNode>();
    const order: string[] = [];
    for (const v of vids) {
      const n = monthName(v);
      let g = map.get(n);
      if (!g) {
        g = { key: `${prefix}|${n}`, name: n, kids: [], vids: [] };
        map.set(n, g);
        order.push(n);
      }
      g.vids.push(v);
    }
    for (const g of map.values())
      g.vids.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    return order.map((n) => map.get(n)!);
  };
  const tabs = Array.from(new Set(videos.map((v) => v.liveTab || "")));
  if (tabs.length <= 1) return byMonth(videos, "L");
  return tabs.map((t) => ({
    key: `L|${t}`,
    name: t || "直播回放",
    kids: byMonth(videos.filter((v) => (v.liveTab || "") === t), `L|${t}`),
    vids: [],
  }));
}
