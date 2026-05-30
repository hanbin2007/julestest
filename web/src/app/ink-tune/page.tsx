"use client";
import * as React from "react";
import Link from "next/link";
import { useAnnotation } from "@/components/annotate/useAnnotation";
import AnnotationLayer from "@/components/annotate/AnnotationLayer";
import { InkStrokeProcessor } from "@/components/annotate/inkProcessor";
import { drawObject } from "@/components/annotate/renderEngine";
import { tuning, type InkTuning } from "@/components/annotate/inkTuning";
import { identity, COLORS, WIDTHS, newId, type InkObject } from "@/components/annotate/model";
import type { RawSample } from "@/components/annotate/inputPipeline";

// 出厂基线快照:模块导入时深拷贝(先于任何挂载/localStorage 改写 tuning)。A/B 与卸载还原都用它。
const BASELINE_TUNING: InkTuning = structuredClone(tuning);

// 模块级探针(survive 页面卸载):e2e 验证"卸载后全局 tuning 已还原出厂"(候选不泄漏进真实播放器)。
if (typeof window !== "undefined") {
  (window as typeof window & { __inkTuningProbe?: () => InkTuning }).__inkTuningProbe = () =>
    structuredClone(tuning);
}

interface RecordedStroke {
  id: string;
  raw: RawSample[]; // 归一化 0–1 + t
  w: number;
  h: number; // 录制时画布像素尺寸
  tool: "pen" | "marker";
  color: string;
  width: number;
}

const LS_STROKES = "inktune.strokes.v1";
const LS_TUNING = "inktune.tuning.v1";
const dpr = () => Math.min((typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1, 2);

// 临时把全局 tuning 设为某套参数跑 fn 再还原(inkOutlinePath 读模块级全局 tuning,这是让基线与候选
// 用不同渲染参数的唯一途径)。就地改字段——tuning 是 const 不可重赋值。
function withGlobalTuning(cfg: InkTuning, fn: () => void) {
  const snap = structuredClone(tuning);
  Object.assign(tuning, structuredClone(cfg));
  try {
    fn();
  } finally {
    Object.assign(tuning, snap);
  }
}

export default function InkTunePage() {
  const api = useAnnotation();
  const stageRef = React.useRef<HTMLCanvasElement>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const stageSizeRef = React.useRef({ w: 0, h: 0 });
  const strokesRef = React.useRef<RecordedStroke[]>([]);
  const [strokeCount, setStrokeCount] = React.useState(0);
  const [tool, setTool] = React.useState<"pen" | "marker">("pen");
  const [color, setColor] = React.useState<string>(COLORS[0]);
  const [width, setWidth] = React.useState<number>(WIDTHS[1]);
  const [abEnabled, setAbEnabled] = React.useState(false);
  const abRef = React.useRef(false);
  abRef.current = abEnabled;
  const [recording, setRecording] = React.useState(true);
  const recordingRef = React.useRef(true);
  recordingRef.current = recording;
  const [, force] = React.useReducer((x) => x + 1, 0); // 改 tuning 后驱动控制面板回显

  // 把工具/颜色/线宽同步进 api(AnnotationLayer 从 api 读)。
  // 依赖【不能】列 api:useAnnotation() 每次 render 返回新对象,列进去会让本 effect 每帧重跑,
  // 而 api.setTool 内部 setSelectedIds(new Set()) 每次都是新引用 → 触发重渲染 → 死循环忙转,
  // 主线程被霸占后连 startTransition(客户端路由跳转)都无法提交。api 的三个 setter 均为稳定引用。
  React.useEffect(() => {
    api.setTool(tool);
    api.setColor(color);
    api.setWidth(width);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, color, width]);

  const deriveObject = React.useCallback(
    (rs: RecordedStroke, cfg: InkTuning): InkObject => ({
      kind: "ink",
      id: rs.id,
      tool: rs.tool,
      color: rs.color,
      width: rs.width,
      samples: InkStrokeProcessor.processAll(rs.raw, cfg, rs.w, rs.h), // 输入阶段用录制 (w,h)
      transform: identity(),
    }),
    []
  );

  const renderStage = React.useCallback(() => {
    const cv = stageRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const { w, h } = stageSizeRef.current;
    ctx.clearRect(0, 0, w, h);
    const list = strokesRef.current;
    if (abRef.current) {
      // 先画出厂基线幽灵层(输入阶段也用基线,才是完整 A/B);灰 + 低透明区分候选实色。
      withGlobalTuning(BASELINE_TUNING, () => {
        ctx.save();
        ctx.globalAlpha = 0.28;
        for (const rs of list) {
          const o = deriveObject(rs, BASELINE_TUNING);
          drawObject(ctx, { ...o, color: "#9e9e9e" }, w, h);
        }
        ctx.restore();
      });
    }
    for (const rs of list) drawObject(ctx, deriveObject(rs, tuning), w, h); // 候选实色(渲染读全局 tuning)
  }, [deriveObject]);

  // A/B 开关切换 → 重画 stage(基线幽灵层出现/消失)。abRef 已在 render 阶段同步,这里只负责触发重画。
  React.useEffect(() => {
    renderStage();
  }, [abEnabled, renderStage]);

  // ---- 持久化(debounce) ----
  const persistTimer = React.useRef<number | null>(null);
  const persist = React.useCallback(() => {
    if (persistTimer.current != null) clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(LS_STROKES, JSON.stringify(strokesRef.current));
        localStorage.setItem(LS_TUNING, JSON.stringify(tuning));
      } catch {
        /* 配额/隐私模式忽略 */
      }
    }, 250);
  }, []);

  // ---- stage canvas 尺寸同步(与 AnnotationLayer 同盒) ----
  React.useEffect(() => {
    const host = hostRef.current;
    const cv = stageRef.current;
    if (!host || !cv) return;
    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      const d = dpr();
      cv.width = Math.round(w * d);
      cv.height = Math.round(h * d);
      cv.style.width = w + "px";
      cv.style.height = h + "px";
      const ctx = cv.getContext("2d");
      if (ctx) ctx.setTransform(d, 0, 0, d, 0, 0);
      stageSizeRef.current = { w, h };
      renderStage();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    return () => ro.disconnect();
  }, [renderStage]);

  // ---- 提交一笔(来自 AnnotationLayer onCommitStroke) ----
  const onCommitStroke = React.useCallback(
    (
      raw: RawSample[],
      frame: { w: number; h: number },
      meta: { tool: "pen" | "marker"; color: string; width: number }
    ) => {
      if (!recordingRef.current) return; // 录制关:随便涂不污染笔画集
      const rs: RecordedStroke = {
        id: newId(),
        raw,
        w: frame.w,
        h: frame.h,
        tool: meta.tool,
        color: meta.color,
        width: meta.width,
      };
      strokesRef.current = [...strokesRef.current, rs];
      setStrokeCount(strokesRef.current.length);
      persist();
      renderStage();
    },
    [persist, renderStage]
  );

  // ---- 挂载:读 localStorage(灌候选 tuning + 笔画);卸载:还原 tuning 出厂 ----
  React.useEffect(() => {
    try {
      const t = localStorage.getItem(LS_TUNING);
      if (t) Object.assign(tuning, JSON.parse(t)); // 就地灌候选
      const s = localStorage.getItem(LS_STROKES);
      if (s) {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) {
          strokesRef.current = arr;
          setStrokeCount(arr.length);
        }
      }
    } catch {
      /* 损坏数据忽略 */
    }
    renderStage();
    force();
    return () => {
      // 安全攸关:还原全局 tuning 为出厂默认,防候选在同一 SPA 会话泄漏进真实播放器。
      Object.assign(tuning, structuredClone(BASELINE_TUNING));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 改参数:就地改全局 tuning → 重画 + 回显 + 持久化 ----
  const setParam = React.useCallback(
    (path: string, val: number) => {
      const parts = path.split(".");
      // 仅 InkTuning/PenTuning 的已知数值字段;path 形如 "posMinCutoff" | "pen.thinning"
      const t = tuning as unknown as Record<string, number | Record<string, number>>;
      if (parts.length === 1) t[parts[0]] = val;
      else (t[parts[0]] as Record<string, number>)[parts[1]] = val;
      renderStage();
      force();
      persist();
    },
    [persist, renderStage]
  );

  const clearAll = () => {
    strokesRef.current = [];
    setStrokeCount(0);
    persist();
    renderStage();
  };
  const deleteLast = () => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    persist();
    renderStage();
  };
  const resetTuning = () => {
    Object.assign(tuning, structuredClone(BASELINE_TUNING));
    renderStage();
    force();
    persist();
  };
  const exportBundle = React.useCallback(
    () => JSON.stringify({ v: 1, tuning, strokes: strokesRef.current }),
    []
  );
  const importBundle = React.useCallback(
    (json: string) => {
      const o = JSON.parse(json);
      if (o && o.tuning) Object.assign(tuning, o.tuning);
      if (o && Array.isArray(o.strokes)) {
        strokesRef.current = o.strokes as RecordedStroke[];
        setStrokeCount(o.strokes.length);
      }
      renderStage();
      force();
      persist();
    },
    [persist, renderStage]
  );
  const copyParams = () => {
    navigator.clipboard?.writeText(JSON.stringify(tuning, null, 2)).catch(() => {});
  };

  // ---- e2e 钩子 ----
  React.useEffect(() => {
    (window as typeof window & { __inktune?: unknown }).__inktune = {
      InkStrokeProcessor,
      importBundle,
      exportBundle,
      getStrokeCount: () => strokesRef.current.length,
      getTuning: () => structuredClone(tuning),
      setParam,
      setAB: (on: boolean) => setAbEnabled(on),
      stageDataURL: () => stageRef.current?.toDataURL() ?? "",
    };
    return () => {
      delete (window as typeof window & { __inktune?: unknown }).__inktune;
    };
  });

  // ---- 控制面板 ----
  const penCfg = tuning[tool]; // pen / marker 各自渲染参数
  const slider = (label: string, path: string, val: number, min: number, max: number, step: number) => (
    <label key={path} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ width: 110, color: "#bbb" }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        onChange={(e) => setParam(path, parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ width: 44, textAlign: "right" }}>{val}</span>
    </label>
  );

  return (
    <div style={{ display: "flex", height: "100dvh", minHeight: 0, background: "#111", color: "#eee" }}>
      {/* 左:画布舞台。host 为整盒,无 video → AnnotationLayer 与 stage canvas 同盒对齐 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 12px", display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/" style={{ color: "#4fc3f7" }}>
            ← 返回
          </Link>
          <strong>墨迹调参回放台</strong>
          <span style={{ color: "#888", fontSize: 13 }}>笔画 {strokeCount}</span>
        </div>
        <div ref={hostRef} style={{ position: "relative", flex: 1, minHeight: 0, background: "#1b1b1f" }}>
          <canvas ref={stageRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
          <AnnotationLayer api={api} onCommitStroke={onCommitStroke} />
        </div>
      </div>

      {/* 右:控制面板 */}
      <div style={{ width: 320, overflowY: "auto", padding: 12, borderLeft: "1px solid #333", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["pen", "marker"] as const).map((t) => (
            <button key={t} onClick={() => setTool(t)} style={{ flex: 1, padding: 6, background: tool === t ? "#4fc3f7" : "#222", color: tool === t ? "#000" : "#eee", border: 0, borderRadius: 6 }}>
              {t === "pen" ? "笔" : "荧光"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {WIDTHS.map((w) => (
            <button key={w} onClick={() => setWidth(w)} style={{ flex: 1, padding: 6, background: width === w ? "#4fc3f7" : "#222", color: width === w ? "#000" : "#eee", border: 0, borderRadius: 6 }}>
              {w}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, background: c, border: color === c ? "2px solid #fff" : "1px solid #555", borderRadius: 6 }} />
          ))}
        </div>

        <fieldset style={{ border: "1px solid #333", borderRadius: 6, padding: 8 }}>
          <legend style={{ fontSize: 12, color: "#888" }}>One Euro(两工具共用)</legend>
          {slider("posMinCutoff", "posMinCutoff", tuning.posMinCutoff, 0.1, 10, 0.1)}
          {slider("posBeta", "posBeta", tuning.posBeta, 0, 3, 0.01)}
          {slider("dCutoff", "dCutoff", tuning.dCutoff, 0.1, 5, 0.1)}
          {slider("pressMinCutoff", "pressMinCutoff", tuning.pressMinCutoff, 0.1, 10, 0.1)}
          {slider("pressBeta", "pressBeta", tuning.pressBeta, 0, 3, 0.01)}
          {slider("cornerStrength", "cornerStrength", tuning.cornerStrength, 0, 1, 0.01)}
          {slider("minSampleDist", "minSampleDist", tuning.minSampleDist, 0, 5, 0.05)}
        </fieldset>

        <fieldset style={{ border: "1px solid #333", borderRadius: 6, padding: 8 }}>
          <legend style={{ fontSize: 12, color: "#888" }}>渲染:{tool === "pen" ? "笔" : "荧光"}</legend>
          {slider("thinning", `${tool}.thinning`, penCfg.thinning, -1, 1, 0.01)}
          {slider("smoothing", `${tool}.smoothing`, penCfg.smoothing, 0, 1, 0.01)}
          {slider("streamline", `${tool}.streamline`, penCfg.streamline, 0, 1, 0.01)}
          {slider("taperStart", `${tool}.taperStart`, penCfg.taperStart, 0, 4, 0.1)}
          {slider("taperEnd", `${tool}.taperEnd`, penCfg.taperEnd, 0, 4, 0.1)}
        </fieldset>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} /> 对比基线(A/B 幽灵层)
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} /> 录制(关掉可随便涂)
        </label>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={deleteLast} style={{ flex: 1, padding: 6 }}>删最后一笔</button>
          <button onClick={clearAll} style={{ flex: 1, padding: 6 }}>清空全部</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={resetTuning} style={{ flex: 1, padding: 6 }}>重置出厂</button>
          <button onClick={copyParams} style={{ flex: 1, padding: 6 }}>复制参数</button>
        </div>
        <button
          onClick={() => {
            const blob = new Blob([exportBundle()], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "inktune.json";
            a.click();
            URL.revokeObjectURL(a.href);
          }}
          style={{ padding: 6 }}
        >
          导出 JSON
        </button>
        <label style={{ padding: 6, background: "#222", borderRadius: 6, textAlign: "center", cursor: "pointer", fontSize: 13 }}>
          导入 JSON
          <input
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) importBundle(await f.text());
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
