"use client";
// 临时调优页（不进 main）：在 iPad 上实时调墨迹手感参数做 A/B。
// 用法：用 Apple Pencil 在画布上写字 → 改预设/滑条 → 再写一笔对比 →「复制参数」把赢的值发回。
// 复用真实 AnnotationLayer（同一渲染管线，所见即所得）；改 tuning 后下一笔即生效。
import * as React from "react";
import {
  Box, Card, Stack, Slider, Typography, Button, ButtonGroup, Divider, Chip, Snackbar,
} from "@mui/material";
import AnnotationLayer from "@/components/annotate/AnnotationLayer";
import { useAnnotation } from "@/components/annotate/useAnnotation";
import { tuning, PRESETS } from "@/components/annotate/inkTuning";
import { WIDTHS } from "@/components/annotate/model";

type Path = string; // "posMinCutoff" | "pen.streamline" ...
const get = (p: Path): number => (p.includes(".") ? (tuning as any).pen[p.split(".")[1]] : (tuning as any)[p]);
const set = (p: Path, v: number) => {
  if (p.includes(".")) (tuning as any).pen[p.split(".")[1]] = v;
  else (tuning as any)[p] = v;
};

const SLIDERS: { p: Path; label: string; min: number; max: number; step: number; hint: string }[] = [
  { p: "posMinCutoff", label: "防抖强度", min: 0.2, max: 4, step: 0.1, hint: "越小越平滑(慢速去抖狠)" },
  { p: "posBeta", label: "跟手度", min: 0, max: 1.5, step: 0.05, hint: "越大快速越跟手(降延迟)" },
  { p: "pen.streamline", label: "流线化", min: 0, max: 0.6, step: 0.02, hint: "额外平滑(会加一点延迟)" },
  { p: "pen.smoothing", label: "轮廓柔化", min: 0, max: 1, step: 0.05, hint: "边缘柔和度" },
  { p: "pen.thinning", label: "压感粗细差", min: 0, max: 0.9, step: 0.05, hint: "越大轻重笔差越明显" },
  { p: "pen.taperEnd", label: "收笔出锋", min: 0, max: 4, step: 0.1, hint: "收笔收尖长度(×笔宽)" },
  { p: "pen.taperStart", label: "起笔出锋", min: 0, max: 4, step: 0.1, hint: "起笔收尖长度(×笔宽)" },
  { p: "pressMinCutoff", label: "压感平滑", min: 0.5, max: 6, step: 0.5, hint: "越小线宽越均匀" },
  { p: "minSampleDist", label: "抽稀间距", min: 0.5, max: 3, step: 0.1, hint: "采样最小间距(px)" },
];

export default function InkTune() {
  const api = useAnnotation();
  const [, force] = React.useReducer((x) => x + 1, 0);
  const [toast, setToast] = React.useState("");

  React.useEffect(() => {
    api.setTool("pen");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = (name: string) => {
    const pre = PRESETS[name];
    if (!pre) return;
    for (const k of Object.keys(pre) as (keyof typeof pre)[]) {
      if (k === "pen") Object.assign(tuning.pen, pre.pen);
      else if (k === "marker") Object.assign(tuning.marker, pre.marker);
      else (tuning as any)[k] = (pre as any)[k];
    }
    force();
    setToast(`已应用预设：${name}（再写一笔对比）`);
  };

  const copyValues = async () => {
    const json = JSON.stringify(
      { posMinCutoff: tuning.posMinCutoff, posBeta: tuning.posBeta, dCutoff: tuning.dCutoff,
        pressMinCutoff: tuning.pressMinCutoff, pressBeta: tuning.pressBeta,
        pen: tuning.pen, marker: tuning.marker, minSampleDist: tuning.minSampleDist },
      null, 2
    );
    try { await navigator.clipboard.writeText(json); setToast("当前参数已复制到剪贴板"); }
    catch { setToast(json); } // 复制失败就显示出来让你截图
  };

  return (
    <Box sx={{ position: "fixed", inset: 0, bgcolor: "#15151a" }}>
      {/* 画布区：留出右侧面板宽度 */}
      <Box id="tune-stage" sx={{ position: "absolute", left: 0, top: 0, right: 320, bottom: 0, bgcolor: "#26262e" }}>
        <AnnotationLayer api={api} />
      </Box>

      {/* 控制面板 */}
      <Card sx={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 320, overflowY: "auto",
        p: 1.5, borderRadius: 0, bgcolor: "md3.surfaceContainerHigh" }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>墨迹手感调优</Typography>
        <Typography variant="caption" color="text.secondary">用 Pencil 在左侧写字，改参数后再写一笔对比</Typography>

        <Stack direction="row" spacing={0.5} sx={{ my: 1, flexWrap: "wrap", gap: 0.5 }}>
          {Object.keys(PRESETS).map((n) => (
            <Chip key={n} label={n} size="small" onClick={() => applyPreset(n)} sx={{ cursor: "pointer" }} />
          ))}
        </Stack>

        <Divider sx={{ my: 1 }} />

        {/* 笔/荧光笔 + 线宽 */}
        <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: "center" }}>
          <ButtonGroup size="small" variant="outlined">
            <Button variant={api.tool === "pen" ? "contained" : "outlined"} onClick={() => api.setTool("pen")}>笔</Button>
            <Button variant={api.tool === "marker" ? "contained" : "outlined"} onClick={() => api.setTool("marker")}>荧光</Button>
          </ButtonGroup>
          <ButtonGroup size="small" variant="outlined">
            {WIDTHS.map((wd, i) => (
              <Button key={wd} variant={api.width === wd ? "contained" : "outlined"} onClick={() => api.setWidth(wd)}>
                {["细", "中", "粗", "特"][i]}
              </Button>
            ))}
          </ButtonGroup>
        </Stack>

        {SLIDERS.map(({ p, label, min, max, step, hint }) => (
          <Box key={p} sx={{ mb: 0.5 }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption" sx={{ fontWeight: 600 }}>{label}</Typography>
              <Typography variant="caption" color="primary">{get(p).toFixed(2)}</Typography>
            </Stack>
            <Slider size="small" min={min} max={max} step={step} value={get(p)}
              onChange={(_, v) => { set(p, v as number); force(); }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: -0.5 }}>{hint}</Typography>
          </Box>
        ))}

        <Divider sx={{ my: 1 }} />
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" fullWidth onClick={() => { api.clear(); }}>清空画布</Button>
          <Button size="small" variant="contained" fullWidth onClick={copyValues}>复制参数</Button>
        </Stack>
      </Card>

      <Snackbar open={!!toast} autoHideDuration={2500} onClose={() => setToast("")} message={toast} />
    </Box>
  );
}
