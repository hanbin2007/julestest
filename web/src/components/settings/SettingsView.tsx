"use client";
import * as React from "react";
import useSWR from "swr";
import {
  Box,
  Button,
  Card,
  MenuItem,
  Stack,
  TextField,
  Typography,
  LinearProgress,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { useCourses, useAllCourseVideos, useStatus } from "@/hooks/data";
import { usePrefs } from "@/hooks/persist";
import { useToast } from "@/components/common/Toast";
import LectureGrid, { type GridRow } from "./LectureGrid";
import StorageDonut from "./StorageDonut";
import { batchThumbs, batchBuffer, getThumbsStatus } from "@/lib/api";
import { pickLow, pickM3u8, fmtBytes } from "@/lib/media";
import type { Video, VideoRow } from "@/types/api";

const MK_THUMB = (v: Video) => ({
  videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
  productId: v.productId, duration: v.duration, src: pickLow(v),
});
const MK_BUF = (v: Video) => ({
  videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
  productId: v.productId, src: pickM3u8(v) ?? "",
});

export default function SettingsView() {
  const toast = useToast();
  const { courses } = useCourses();
  const { rows, loaded, total } = useAllCourseVideos(courses);
  const { status, refresh } = useStatus(true);
  const { data: thumbsStatus } = useSWR("/api/thumbs/status", getThumbsStatus, { refreshInterval: 4000 });
  const { prefs, setPrefs } = usePrefs();

  const [q, setQ] = React.useState("");
  const [courseId, setCourseId] = React.useState("");
  const [thumbF, setThumbF] = React.useState("");
  const [bufF, setBufF] = React.useState("");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  const tState = (id: number) => status?.thumb.states[String(id)];
  const bInfo = (id: number) => status?.buffer.perVid[String(id)];
  const isBuffered = (id: number) => {
    const b = bInfo(id);
    return b ? b.state === "done" || (!!b.total && b.cached >= b.total) : false;
  };

  const filtered: VideoRow[] = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (courseId && String(r.courseId) !== courseId) return false;
      if (s && !((r.v.title ?? "").toLowerCase().includes(s) || r.courseName.toLowerCase().includes(s))) return false;
      const ts = tState(r.v.videoId);
      if (thumbF === "ready" && ts !== "ready") return false;
      if (thumbF === "gen" && ts !== "gen") return false;
      if (thumbF === "missing" && (ts === "ready" || ts === "gen")) return false;
      const bd = isBuffered(r.v.videoId);
      if (bufF === "done" && !bd) return false;
      if (bufF === "missing" && bd) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, courseId, thumbF, bufF, status]);

  const gridRows: GridRow[] = React.useMemo(
    () =>
      filtered.map((r) => {
        const b = bInfo(r.v.videoId);
        const ts = tState(r.v.videoId);
        return {
          id: r.v.videoId,
          courseName: r.courseName,
          title: r.v.title ?? `视频 ${r.v.videoId}`,
          duration: r.v.duration,
          thumbState: (ts ?? "none") as GridRow["thumbState"],
          bufCached: b?.cached ?? 0,
          bufTotal: b?.total ?? null,
          bufState: b?.state ?? null,
          vrow: r,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, status]
  );

  const targets = (): Video[] => {
    if (selected.size) return rows.filter((r) => selected.has(r.v.videoId)).map((r) => r.v);
    return filtered.map((r) => r.v);
  };
  const runThumb = async () => {
    const t = targets();
    if (!t.length) return toast("没有可处理的讲次");
    try {
      const r = await batchThumbs(t.map(MK_THUMB));
      toast(`已加入队列 ${r.queued}（跳过 ${r.skipped}）`, { severity: "success" });
      refresh();
    } catch (e) {
      toast("提交失败：" + (e as Error).message, { severity: "error" });
    }
  };
  const runBuf = async () => {
    const t = targets().filter((v) => pickM3u8(v));
    if (!t.length) return toast("没有可处理的讲次");
    try {
      const r = await batchBuffer(t.map(MK_BUF));
      toast(`已加入队列 ${r.queued}（跳过 ${r.skipped}）`, { severity: "success" });
      refresh();
    } catch (e) {
      toast("提交失败：" + (e as Error).message, { severity: "error" });
    }
  };
  const rowThumb = async (r: VideoRow) => {
    await batchThumbs([MK_THUMB(r.v)]);
    toast("已加入缩略图队列");
    refresh();
  };
  const rowBuf = async (r: VideoRow) => {
    if (!pickM3u8(r.v)) return;
    await batchBuffer([MK_BUF(r.v)]);
    toast("已加入缓冲队列");
    refresh();
  };

  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const toggleAll = (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      gridRows.forEach((r) => (on ? n.add(r.id) : n.delete(r.id)));
      return n;
    });

  const tReady = filtered.filter((r) => tState(r.v.videoId) === "ready").length;
  const bDone = filtered.filter((r) => isBuffered(r.v.videoId)).length;
  const ft = filtered.length || 1;
  const loadingCourses = total > 0 && loaded < total;

  return (
    <Box sx={{ maxWidth: 1180, mx: "auto", p: { xs: 1.5, md: 3 } }}>
      <Typography variant="h5" gutterBottom>
        预生成 &amp; 缓冲
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        提前生成拖动缩略图、把整集缓冲到服务端，看课更顺。缩略图持久保存；整集缓冲走磁盘缓存（LRU，受上限约束）。
        {loadingCourses ? `　课程加载中 ${loaded}/${total}…` : ""}
      </Typography>

      <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mb: 2 }}>
        <Card sx={{ p: 2, flex: 1 }}>
          <StorageDonut used={status?.buffer.bytes ?? 0} limit={status?.buffer.limit ?? 1} />
        </Card>
        <Card sx={{ p: 2, flex: 1 }}>
          <Typography variant="subtitle2" gutterBottom>信息</Typography>
          <Info k="缩略图目录" v={status?.thumbDir ?? "—"} />
          <Info k="缩略图占用" v={fmtBytes(thumbsStatus?.bytes)} />
          <Info k="缓冲缓存" v={`${fmtBytes(status?.buffer.bytes)} / ${fmtBytes(status?.buffer.limit)}`} />
          <Info k="ffmpeg" v={status ? (status.ffmpeg ? "可用" : "未安装") : "—"} />
        </Card>
      </Stack>

      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap", gap: 1.5, mb: 1.5 }}>
          <TextField size="small" placeholder="搜索讲次 / 课程…" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 180 }} />
          <TextField size="small" select label="课程" value={courseId} onChange={(e) => setCourseId(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="">全部（{courses.length}）</MenuItem>
            {courses.map((c) => (
              <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>
            ))}
          </TextField>
          <TextField size="small" select label="缩略图" value={thumbF} onChange={(e) => setThumbF(e.target.value)} sx={{ minWidth: 120 }}>
            <MenuItem value="">全部</MenuItem>
            <MenuItem value="ready">已生成</MenuItem>
            <MenuItem value="gen">生成中</MenuItem>
            <MenuItem value="missing">未生成</MenuItem>
          </TextField>
          <TextField size="small" select label="缓冲" value={bufF} onChange={(e) => setBufF(e.target.value)} sx={{ minWidth: 120 }}>
            <MenuItem value="">全部</MenuItem>
            <MenuItem value="done">已缓冲</MenuItem>
            <MenuItem value="missing">未缓冲</MenuItem>
          </TextField>
        </Stack>
        <Stack direction="row" spacing={1.2} sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {selected.size ? `已选 ${selected.size}` : `显示 ${filtered.length} / 共 ${rows.length} 讲`}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={prefs.density}
            onChange={(_e, v) => v && setPrefs({ density: v })}
          >
            <ToggleButton value="comfortable">宽松</ToggleButton>
            <ToggleButton value="compact">紧凑</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" onClick={runThumb}>生成缩略图</Button>
          <Button variant="outlined" onClick={runBuf}>缓冲整集</Button>
          <Button variant="text" onClick={() => refresh()}>刷新</Button>
        </Stack>
        <Box sx={{ mt: 1.5 }}>
          <ProgRow label="缩略图" value={(tReady / ft) * 100} text={`${tReady}/${filtered.length}　生成中 ${status?.thumb.generating.length ?? 0}　队列 ${status?.thumb.queued ?? 0}`} />
          <ProgRow label="缓冲" value={(bDone / ft) * 100} text={`${bDone}/${filtered.length}　缓冲中 ${status?.buffer.working.length ?? 0}　队列 ${status?.buffer.queued ?? 0}`} color="success" />
        </Box>
      </Card>

      <Card sx={{ p: 0, height: 560 }}>
        <LectureGrid
          rows={gridRows}
          selected={selected}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onRowThumb={rowThumb}
          onRowBuf={rowBuf}
          density={prefs.density}
        />
      </Card>
    </Box>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", py: 0.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
      <Typography variant="body2" color="text.secondary">{k}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, ml: 2, textAlign: "right", wordBreak: "break-all" }}>{v}</Typography>
    </Box>
  );
}
function ProgRow({ label, value, text, color }: { label: string; value: number; text: string; color?: "primary" | "success" }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ width: 42 }}>{label}</Typography>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, value)}
        color={color}
        sx={{ flex: 1 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 180, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {text}
      </Typography>
    </Box>
  );
}
