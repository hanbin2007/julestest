"use client";
import useSWR, { mutate as globalMutate } from "swr";
import * as api from "@/lib/api";
import type { EnrichedNote, LastWatched, Note, NotesStats, Prefs, ProgressMap } from "@/lib/store";

// 状态全部走服务端（SQLite），SWR 缓存 + 焦点重验 = 跨设备同步。

export function useProgressMap(): ProgressMap {
  const { data } = useSWR("/api/progress", () => api.getProgressAll(), {
    revalidateOnFocus: true,
  });
  return data?.progress ?? {};
}

// productId:笔记按产品作用域读 + 建笔记时绑课用（来自当前 sel.courseId）。
// SWR key 与 getNotes 的 URL 必须一致：productId 为 null 时整个省略该参数（不可传空串）。
export function useNotes(videoId: number | null, productId: number | null = null) {
  const key =
    videoId == null
      ? null
      : `/api/notes?videoId=${videoId}` + (productId != null ? `&productId=${productId}` : "");
  const { data, mutate } = useSWR(
    key,
    () => api.getNotes(videoId as number, productId),
    { revalidateOnFocus: true },
  );
  const notes: Note[] = data?.notes ?? [];
  type NotesData = { notes: Note[] };

  const add = async (t: number, text: string, snap?: string | null, strokes?: string) => {
    if (videoId == null || !text.trim()) return;
    const optimistic: Note = { id: `tmp-${Date.now()}`, t, text: text.trim(), strokes: strokes ?? null, at: Date.now() };
    await mutate(
      async () => {
        const r = await api.addNote(videoId, productId, t, text.trim(), strokes);
        // 拿到服务端分配的 id 后，把记笔记那一刻抓的画面存为该笔记的截图
        if (snap && r.note) {
          try {
            await api.saveNoteSnapshot(r.note.id, snap);
          } catch {
            /* 截图失败不影响笔记本身 */
          }
        }
        return { notes: r.notes };
      },
      {
        // 函数式：基于当前缓存而非闭包快照，避免连续快速操作互相覆盖（闪烁）
        optimisticData: (cur) => ({
          notes: [...((cur as NotesData | undefined)?.notes ?? []), optimistic].sort((a, b) => a.t - b.t),
        }),
        rollbackOnError: true,
        revalidate: false,
      },
    );
    void globalMutate("/api/notes/all"); // 让统一管理页 / 分屏面板 / 时间轴打点同步
  };

  const update = async (id: string, text: string, strokes?: string, snap?: string | null) => {
    if (videoId == null || !text.trim()) return;
    const next = text.trim();
    await mutate(
      async () => {
        const r = await api.updateNote(videoId, id, next, strokes, productId);
        // 再编辑批注：覆盖该笔记的合成图（snapshot 通道按 id 覆盖、已去 immutable 缓存）
        if (snap) {
          try {
            await api.saveNoteSnapshot(id, snap);
          } catch {
            /* 截图失败不影响笔记本身 */
          }
        }
        return { notes: r.notes };
      },
      {
        optimisticData: (cur) => ({
          notes: ((cur as NotesData | undefined)?.notes ?? []).map((n) =>
            n.id === id ? { ...n, text: next, ...(strokes !== undefined && { strokes }) } : n,
          ),
        }),
        rollbackOnError: true,
        revalidate: false,
      },
    );
    void globalMutate("/api/notes/all");
  };

  const remove = async (id: string) => {
    if (videoId == null) return;
    await mutate(
      async () => ({ notes: (await api.deleteNote(videoId, id, productId)).notes }),
      {
        optimisticData: (cur) => ({
          notes: ((cur as NotesData | undefined)?.notes ?? []).filter((n) => n.id !== id),
        }),
        rollbackOnError: true,
        revalidate: false,
      },
    );
    void globalMutate("/api/notes/all");
  };

  return { notes, add, update, remove };
}

// 统一管理：全量富化笔记 + 统计。改/删复用单讲端点，删按全局唯一 id 批量。
// 每次变更顺带重验对应单讲 key(/api/notes?videoId=)，让看课页抽屉同步。
export function useAllNotes() {
  const { data, mutate } = useSWR("/api/notes/all", () => api.getAllNotes(), {
    revalidateOnFocus: true,
  });
  const notes: EnrichedNote[] = data?.notes ?? [];
  const stats: NotesStats = data?.stats ?? { total: 0, videos: 0, courses: 0 };

  // 单讲 key 现已带 &productId 变体，按前缀匹配重验该 videoId 的所有变体。
  // 锚定边界（精确等于或后跟 &），避免 videoId=10 误匹配 100/101 等。
  const revalidateVideo = (videoId: number) => {
    const base = `/api/notes?videoId=${videoId}`;
    return globalMutate((k) => typeof k === "string" && (k === base || k.startsWith(base + "&")));
  };

  const update = async (videoId: number, id: string, text: string) => {
    const next = text.trim();
    if (!next) return;
    await mutate(
      async () => {
        await api.updateNote(videoId, id, next);
        void revalidateVideo(videoId);
        return api.getAllNotes();
      },
      {
        optimisticData: data
          ? { ...data, notes: notes.map((n) => (n.id === id ? { ...n, text: next } : n)) }
          : undefined,
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  const remove = async (videoId: number, id: string) => {
    await mutate(
      async () => {
        await api.deleteNote(videoId, id);
        void revalidateVideo(videoId);
        return api.getAllNotes();
      },
      {
        optimisticData: data
          ? { ...data, notes: notes.filter((n) => n.id !== id) }
          : undefined,
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  const removeBatch = async (ids: string[]) => {
    if (ids.length === 0) return;
    const idset = new Set(ids);
    const affected = new Set(notes.filter((n) => idset.has(n.id)).map((n) => n.videoId));
    await mutate(
      async () => {
        await api.deleteNotesBatch(ids);
        affected.forEach((v) => void revalidateVideo(v));
        return api.getAllNotes();
      },
      {
        optimisticData: data
          ? { ...data, notes: notes.filter((n) => !idset.has(n.id)) }
          : undefined,
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  return { notes, stats, update, remove, removeBatch };
}

export function usePrefs() {
  const { data, mutate } = useSWR("/api/settings", () => api.getSettings(), {
    revalidateOnFocus: false,
  });
  const prefs: Prefs = data?.prefs ?? { rate: 1, density: "comfortable" };
  const setPrefs = async (p: Partial<Prefs>) => {
    await mutate(
      async () => {
        await api.patchSettings({ prefs: p });
        return api.getSettings();
      },
      {
        optimisticData: data
          ? { ...data, prefs: { ...prefs, ...p } }
          : { prefs: { ...prefs, ...p }, last: null },
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };
  return { prefs, setPrefs };
}

export function useLast(): LastWatched | null {
  const { data } = useSWR("/api/settings", () => api.getSettings(), {
    revalidateOnFocus: false,
  });
  return data?.last ?? null;
}
