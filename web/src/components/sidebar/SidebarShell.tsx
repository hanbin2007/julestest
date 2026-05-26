"use client";
import * as React from "react";
import { Box } from "@mui/material";
import { usePrefs } from "@/hooks/persist";

// 桌面侧栏宽度常量：默认 340，可拖范围 [240, 560]，双击拖拽带回到 340。
// 240 是头部图标行 + 搜索框不挤变形的下限；560 是再宽就盖到播放器了。
export const SIDEBAR_DEFAULT_WIDTH = 340;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 首页课程侧栏的桌面外壳：
 *  - 折叠（sidebarCollapsed）= 宽度过渡到 0、隐去边线；CourseSidebar 保持挂载，状态不丢
 *  - 拖拽右边缘可调宽度，[240,560] 夹紧；pointerup 才写一次 Prefs（避免抖动写风暴）
 *  - 双击拖拽带复位到 340
 *  - 只在 md+ 渲染；手机端继续走 <Drawer>
 */
export default function SidebarShell({ children }: { children: React.ReactNode }) {
  const { prefs, setPrefs, loaded } = usePrefs();
  const collapsed = !!prefs.sidebarCollapsed;
  const persistedW = clamp(
    prefs.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  );
  // 拖拽过程中本地 state 跟手；松手才一次性 setPrefs。
  const [dragW, setDragW] = React.useState<number | null>(null);
  const effectiveW = dragW ?? persistedW;
  // 仅在 SWR 真正落地 + 下一帧绘制完成后才允许过渡动画，
  // 否则首次从默认 340 切到用户存的值会触发可见的「收缩动画」闪烁。
  const [animateReady, setAnimateReady] = React.useState(false);
  React.useEffect(() => {
    if (!loaded || animateReady) return;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setAnimateReady(true)),
    );
    return () => cancelAnimationFrame(id);
  }, [loaded, animateReady]);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return; // 折叠中拖拽无意义
    e.preventDefault();
    const startX = e.clientX;
    const startW = persistedW;
    const onMove = (ev: PointerEvent) => {
      setDragW(clamp(startW + (ev.clientX - startX), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDragW((cur) => {
        // 只有值变了才写盘，避免无变化的 setPrefs 调用。
        if (cur != null && cur !== persistedW) void setPrefs({ sidebarWidth: cur });
        return null;
      });
    };
    // 拖拽期间整页禁文本选中 + 全局 col-resize 光标，越过窗格也保持手感。
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const resetWidth = () => {
    setDragW(null);
    if (persistedW !== SIDEBAR_DEFAULT_WIDTH) void setPrefs({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
  };

  return (
    <Box
      aria-hidden={collapsed || undefined}
      sx={{
        width: collapsed ? 0 : effectiveW,
        flex: "0 0 auto",
        display: { xs: "none", md: "block" },
        borderRight: (t) => (collapsed ? "none" : `1px solid ${t.palette.divider}`),
        bgcolor: "md3.surfaceContainerLow",
        position: "relative",
        overflow: "hidden",
        // 拖拽时 / SWR 落地后头两帧关掉过渡，避免初始默认 340 切到用户保存值时的闪烁动画；
        // 之后真正的用户操作（折叠/展开/复位）才走 .18s 平滑过渡。
        transition: dragW != null || !animateReady ? "none" : "width .18s ease-out",
      }}
    >
      {children}
      {!collapsed && (
        <Box
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧栏宽度（双击复位 340）"
          onPointerDown={startDrag}
          onDoubleClick={resetWidth}
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 2,
            // 悬停时整条变淡主题色，告诉用户「这里可以拖」。
            transition: "background-color .15s",
            "&:hover, &:active": {
              bgcolor: (t) => `${t.palette.primary.main}33`,
            },
          }}
        />
      )}
    </Box>
  );
}
