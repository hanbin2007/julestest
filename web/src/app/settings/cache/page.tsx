"use client";
import * as React from "react";
import { Box, Button, Card, MenuItem, Stack, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { useAllCourseVideos, markRecentAction, useCoursesStatus } from "@/hooks/data";
import { usePrefs } from "@/hooks/persist";
import { useToast } from "@/components/common/Toast";
import { useSettingsData } from "@/components/settings/SettingsDataContext";
import LectureGrid, { type GridRow } from "@/components/settings/LectureGrid";
import CourseStatusGrid, { type CourseSort } from "@/components/settings/CourseStatusGrid";
import CourseDetailDrawer from "@/components/settings/CourseDetailDrawer";
import { batchThumbs, batchBuffer, getCourseVideos } from "@/lib/api";
import { pickLow, pickM3u8 } from "@/lib/media";
import type { CourseStatus, Video, VideoRow } from "@/types/api";

// 缩略图源：点播取最低清晰度（解码更快）；直播回放无清晰度档 → 回退到 m3u8。liveId 给网关取 AES key。
const thumbSrc = (v: Video) => pickLow(v) || pickM3u8(v) || "";
const MK_THUMB = (v: Video) => ({
  videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
  productId: v.productId, duration: v.duration, src: thumbSrc(v), liveId: v.liveId ?? null,
});
const MK_BUF = (v: Video) => ({
  videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
  productId: v.productId, src: pickM3u8(v) ?? "", liveId: v.liveId ?? null,
});

// 缓存管理：浏览课程/讲次缓存状态，按需缓冲 / 生成缩略图。数据来自 layout 的唯一轮询。
export default function CachePage() {
  const toast = useToast();
  const { data, refresh, courses } = useSettingsData();
  // 订阅 layout 轮询的同一状态源（SWR 按 key 去重，不会多发请求），取其 error。
  // 用于区分「请求出错」与「数据为空」，修复出错时课程网格骨架永转。仅在 data 缺失（首屏失败）
  // 时才下传 error；轮询期单次失败仍保留旧数据（keepPreviousData），避免网络抖动把已渲染的网格打回错误面板。
  const { error: statusError } = useCoursesStatus();
  const { prefs, setPrefs } = usePrefs();
  const [tab, setTab] = React.useState(0);
  const [q, setQ] = React.useState("");
  const [courseId, setCourseId] = React.useState("");
  const [sort, setSort] = React.useState<CourseSort>("default");
  const [thumbF, setThumbF] = React.useState("");
  const [bufF, setBufF] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = React.useState<Set<number>>(new Set());
  const [drawer, setDrawer] = React.useState<CourseStatus | null>(null);

  const flatActive = tab === 1;
  const { rows: allRows, loaded, total } = useAllCourseVideos(flatActive ? courses : []);
  const perVid = data?.perVid ?? {};
  const courseStatus = React.useMemo(() => data?.courses ?? [], [data]);

  const filteredCourses = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return courseStatus.filter((c) => {
      if (courseId && String(c.productId) !== courseId) return false;
      if (s && !c.name.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [courseStatus, q, courseId]);

  const isBuffered = (b?: { state: string | null; cached: number; total: number | null }) =>
    !!b && (b.state === "done" || b.state === "full" || (!!b.total && b.cached >= b.total));
  const gridRows: GridRow[] = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return allRows
      .filter((r) => {
        if (courseId && String(r.courseId) !== courseId) return false;
        if (s && !(r.v.title ?? "").toLowerCase().includes(s) && !r.courseName.toLowerCase().includes(s)) return false;
        const b = perVid[String(r.v.videoId)];
        const ts = b?.thumb ?? "none";
        if (thumbF === "ready" && ts !== "ready") return false;
        if (thumbF === "gen" && ts !== "gen") return false;
        if (thumbF === "missing" && (ts === "ready" || ts === "gen")) return false;
        const bd = isBuffered(b);
        if (bufF === "done" && !bd) return false;
        if (bufF === "missing" && bd) return false;
        return true;
      })
      .map((r) => {
        const b = perVid[String(r.v.videoId)];
        return {
          id: `${r.courseId}:${r.v.videoId}`,
          courseName: r.courseName,
          title: r.v.title ?? `视频 ${r.v.videoId}`,
          duration: r.v.duration,
          kind: (r.v.kind === "live" ? "live" : "vod") as GridRow["kind"],
          bytes: b?.bytes ?? 0,
          thumbState: (b?.thumb ?? "none") as GridRow["thumbState"],
          bufCached: b?.cached ?? 0,
          bufTotal: b?.total ?? null,
          bufState: b?.state ?? null,
          vrow: r,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, q, courseId, thumbF, bufF, data]);

  const submittingRef = React.useRef(false);
  const submit = async (vids: Video[], kind: "thumb" | "buffer") => {
    const t = kind === "thumb" ? vids.filter((v) => thumbSrc(v)) : vids.filter((v) => pickM3u8(v));
    if (!t.length) return toast("没有可处理的讲次");
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const r = kind === "thumb" ? await batchThumbs(t.map(MK_THUMB)) : await batchBuffer(t.map(MK_BUF));
      markRecentAction();
      const reasons = r.skippedReasons ?? {};
      const byReason = new Map<string, number>();
      for (const why of Object.values(reasons)) byReason.set(why, (byReason.get(why) ?? 0) + 1);
      const reasonText =
        byReason.size > 0
          ? "（跳过：" + Array.from(byReason.entries()).map(([why, n]) => `${why} ${n}`).join("、") + "）"
          : r.skipped > 0 ? `（跳过 ${r.skipped}）` : "";
      toast(`已加入队列 ${r.queued}${reasonText}`, { severity: r.queued > 0 ? "success" : r.skipped > 0 ? "warning" : "info" });
      refresh();
    } catch (e) {
      toast("提交失败：" + (e as Error).message, { severity: "error" });
    } finally {
      submittingRef.current = false;
    }
  };

  const courseAction = async (c: CourseStatus, kind: "thumb" | "buffer") => {
    setBusyIds((s) => new Set(s).add(c.productId));
    try {
      const { videos } = await getCourseVideos(c.productId);
      await submit(videos.filter((v) => !v.locked), kind);
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(c.productId); return n; });
    }
  };

  const targets = (): Video[] => {
    if (selected.size) return allRows.filter((r) => selected.has(`${r.courseId}:${r.v.videoId}`)).map((r) => r.v);
    return gridRows.map((r) => r.vrow.v);
  };
  const rowThumb = (r: VideoRow) => submit([r.v], "thumb");
  const rowBuf = (r: VideoRow) => submit([r.v], "buffer");
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleAll = (on: boolean) =>
    setSelected((s) => { const n = new Set(s); gridRows.forEach((r) => (on ? n.add(r.id) : n.delete(r.id))); return n; });
  const loadingCourses = flatActive && total > 0 && loaded < total;

  return (
    <Box sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box>
        <Typography variant="h6">缓存管理</Typography>
        <Typography variant="caption" color="text.disabled">浏览课程与讲次的缓存状态，按需缓冲 / 生成缩略图。</Typography>
      </Box>

      <Card sx={{ p: 2 }}>
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
          <TextField size="small" placeholder="搜索课程 / 讲次…" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 180 }} />
          <TextField size="small" select label="课程" value={courseId} onChange={(e) => setCourseId(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="">全部（{courses.length}）</MenuItem>
            {courses.map((c) => (<MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>))}
          </TextField>
          {!flatActive && (
            <TextField size="small" select label="排序" value={sort} onChange={(e) => setSort(e.target.value as CourseSort)} sx={{ minWidth: 120 }}>
              <MenuItem value="default">默认</MenuItem>
              <MenuItem value="cache">缓存多</MenuItem>
              <MenuItem value="watched">看得多</MenuItem>
              <MenuItem value="size">占用大</MenuItem>
              <MenuItem value="name">名称</MenuItem>
            </TextField>
          )}
          {flatActive && (
            <>
              <TextField size="small" select label="缩略图" value={thumbF} onChange={(e) => setThumbF(e.target.value)} sx={{ minWidth: 110 }}>
                <MenuItem value="">全部</MenuItem>
                <MenuItem value="ready">已生成</MenuItem>
                <MenuItem value="gen">生成中</MenuItem>
                <MenuItem value="missing">未生成</MenuItem>
              </TextField>
              <TextField size="small" select label="缓冲" value={bufF} onChange={(e) => setBufF(e.target.value)} sx={{ minWidth: 110 }}>
                <MenuItem value="">全部</MenuItem>
                <MenuItem value="done">已缓冲</MenuItem>
                <MenuItem value="missing">未缓冲</MenuItem>
              </TextField>
            </>
          )}
          <Stack direction="row" sx={{ ml: { md: "auto" }, flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
            <ToggleButtonGroup
              size="small" exclusive value={prefs.density} onChange={(_e, v) => v && setPrefs({ density: v })}
              sx={{ borderRadius: (t) => t.radius.full, overflow: "hidden", "& .MuiToggleButtonGroup-grouped": { border: 0, borderRadius: 0 } }}
            >
              <ToggleButton value="comfortable">宽松</ToggleButton>
              <ToggleButton value="compact">紧凑</ToggleButton>
            </ToggleButtonGroup>
            <Button variant="contained" startIcon={<ImageOutlinedIcon />} onClick={() => submit(targets(), "thumb")}>生成缩略图</Button>
            <Button variant="outlined" startIcon={<FileDownloadOutlinedIcon />} onClick={() => submit(targets(), "buffer")}>缓冲整集</Button>
          </Stack>
        </Stack>
        <Stack direction="row" sx={{ mt: 1, alignItems: "center" }}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)}>
            <Tab label="按课程" />
            <Tab label="全部讲次" />
          </Tabs>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {flatActive
              ? selected.size ? `已选 ${selected.size}` : `${gridRows.length} 讲${loadingCourses ? `（加载中 ${loaded}/${total}）` : ""}`
              : `${filteredCourses.length} / ${courseStatus.length} 门课`}
          </Typography>
        </Stack>
      </Card>

      {tab === 0 ? (
        <CourseStatusGrid
          courses={filteredCourses}
          loading={!data}
          error={data ? undefined : statusError}
          onRetry={() => refresh()}
          sort={sort}
          busyIds={busyIds}
          onOpen={setDrawer}
          onBuffer={(c) => courseAction(c, "buffer")}
          onThumbs={(c) => courseAction(c, "thumb")}
        />
      ) : (
        <Card sx={{ p: 0, height: { xs: "calc(100dvh - 360px)", md: "min(70dvh, 820px)" }, minHeight: 420, overflow: "hidden" }}>
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
      )}

      <CourseDetailDrawer
        course={drawer}
        perVid={perVid}
        density={prefs.density}
        onRowThumb={rowThumb}
        onRowBuf={rowBuf}
        onClose={() => setDrawer(null)}
      />
    </Box>
  );
}
