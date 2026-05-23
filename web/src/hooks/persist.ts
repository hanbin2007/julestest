"use client";
import useSWR from "swr";
import * as api from "@/lib/api";
import type { LastWatched, Note, Prefs, ProgressMap } from "@/lib/store";

// 状态全部走服务端（SQLite），SWR 缓存 + 焦点重验 = 跨设备同步。

export function useProgressMap(): ProgressMap {
  const { data } = useSWR("/api/progress", () => api.getProgressAll(), {
    revalidateOnFocus: true,
  });
  return data?.progress ?? {};
}

export function useNotes(videoId: number | null) {
  const key = videoId == null ? null : `/api/notes?videoId=${videoId}`;
  const { data, mutate } = useSWR(
    key,
    () => api.getNotes(videoId as number),
    { revalidateOnFocus: true },
  );
  const notes: Note[] = data?.notes ?? [];

  const add = async (t: number, text: string) => {
    if (videoId == null || !text.trim()) return;
    const optimistic: Note = { id: `tmp-${Date.now()}`, t, text: text.trim(), at: Date.now() };
    await mutate(
      async () => ({ notes: (await api.addNote(videoId, t, text.trim())).notes }),
      {
        optimisticData: { notes: [...notes, optimistic].sort((a, b) => a.t - b.t) },
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  const update = async (id: string, text: string) => {
    if (videoId == null || !text.trim()) return;
    const next = text.trim();
    await mutate(
      async () => ({ notes: (await api.updateNote(videoId, id, next)).notes }),
      {
        optimisticData: { notes: notes.map((n) => (n.id === id ? { ...n, text: next } : n)) },
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  const remove = async (id: string) => {
    if (videoId == null) return;
    await mutate(
      async () => ({ notes: (await api.deleteNote(videoId, id)).notes }),
      {
        optimisticData: { notes: notes.filter((n) => n.id !== id) },
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  return { notes, add, update, remove };
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
