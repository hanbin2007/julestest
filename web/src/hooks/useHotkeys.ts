"use client";
import { useEffect, useRef } from "react";

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/** 全局快捷键；在输入框/可编辑区时不触发。键名用 e.key（小写匹配）。 */
export function useHotkeys(map: HotkeyMap) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    // 单键快捷键在交互控件/可编辑区/弹层内不触发，避免误触（按钮/链接/对话框等聚焦时）。
    const INTERACTIVE =
      'input, textarea, select, [contenteditable], button, a[href], [role=button], [role=menuitem], [role=dialog], [role=menu], [tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      if (target?.closest(INTERACTIVE) || active?.closest(INTERACTIVE)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const h = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (h) h(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
