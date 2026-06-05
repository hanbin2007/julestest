"use client";
import * as React from "react";
import type { KeyedMutator } from "swr";
import { useCourses, useCoursesStatus, type BpsSample } from "@/hooks/data";
import type { Course, CoursesStatus } from "@/types/api";

interface SettingsData {
  data: CoursesStatus | undefined;
  error: unknown;
  refresh: KeyedMutator<CoursesStatus>;
  bps: BpsSample;
  courses: Course[];
}
const Ctx = React.createContext<SettingsData | null>(null);

// layout 持有唯一轮询；子路由切换时 layout 不重渲染 → 轮询不重启、四页同步。
export function SettingsDataProvider({ children }: { children: React.ReactNode }) {
  const { courses } = useCourses();
  // error 透传出去:概览页据此区分「首帧检测中」与「持久取数失败」(后者要给重试,而非永远「检测中…」)。
  const { data, error, refresh, bps } = useCoursesStatus();
  const value = React.useMemo<SettingsData>(() => ({ data, error, refresh, bps, courses }), [data, error, refresh, bps, courses]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettingsData(): SettingsData {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useSettingsData 必须在 SettingsDataProvider 内使用");
  return v;
}
