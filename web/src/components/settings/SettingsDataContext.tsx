"use client";
import * as React from "react";
import type { KeyedMutator } from "swr";
import { useCourses, useCoursesStatus, type BpsSample } from "@/hooks/data";
import type { Course, CoursesStatus } from "@/types/api";

interface SettingsData {
  data: CoursesStatus | undefined;
  refresh: KeyedMutator<CoursesStatus>;
  bps: BpsSample;
  courses: Course[];
}
const Ctx = React.createContext<SettingsData | null>(null);

// layout 持有唯一轮询；子路由切换时 layout 不重渲染 → 轮询不重启、四页同步。
export function SettingsDataProvider({ children }: { children: React.ReactNode }) {
  const { courses } = useCourses();
  const { data, refresh, bps } = useCoursesStatus();
  const value = React.useMemo<SettingsData>(() => ({ data, refresh, bps, courses }), [data, refresh, bps, courses]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettingsData(): SettingsData {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useSettingsData 必须在 SettingsDataProvider 内使用");
  return v;
}
