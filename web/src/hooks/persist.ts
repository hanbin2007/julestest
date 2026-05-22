"use client";
import { useEffect, useMemo, useState } from "react";
import * as store from "@/lib/store";

function useStoreVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const h = () => setV((x) => x + 1);
    window.addEventListener("ydc-store", h as EventListener);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener("ydc-store", h as EventListener);
      window.removeEventListener("storage", h);
    };
  }, []);
  return v;
}

export function useProgressMap() {
  const v = useStoreVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => store.getProgressMap(), [v]);
}

export function useNotes(videoId: number | null) {
  const v = useStoreVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (videoId == null ? [] : store.getNotes(videoId)), [v, videoId]);
}

export function usePrefs() {
  const v = useStoreVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prefs = useMemo(() => store.getPrefs(), [v]);
  return { prefs, setPrefs: store.setPrefs };
}
