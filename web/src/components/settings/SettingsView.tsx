"use client";
import * as React from "react";
import {
  Box,
  Button,
  Card,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useSWRConfig } from "swr";
import { useCourses, useAllCourseVideos, useCoursesStatus } from "@/hooks/data";
import { usePrefs } from "@/hooks/persist";
import { useToast } from "@/components/common/Toast";
import LectureGrid, { type GridRow } from "./LectureGrid";
import HealthBar from "./HealthBar";
import StorageStrip from "./StorageStrip";
import TaskQueuePanel from "./TaskQueuePanel";
import CacheDirCard from "./CacheDirCard";
import AssistantCard from "./AssistantCard";
import CourseStatusGrid, { type CourseSort } from "./CourseStatusGrid";
import CourseDetailDrawer from "./CourseDetailDrawer";
import { batchThumbs, batchBuffer, getCourseVideos, syncYoudaoProgress } from "@/lib/api";
import { pickLow, pickM3u8 } from "@/lib/media";
import type { CourseStatus, Video, VideoRow } from "@/types/api";

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
  const { mutate } = useSWRConfig();
  const { courses } = useCourses();
  const { data, refresh, bps } = useCoursesStatus();

  const { prefs, setPrefs } = usePrefs();
  const [syncing, setSyncing] = React.useState(false);
  const [tab, setTab] = React.useState(0);
  const [q, setQ] = React.useState("");
  const [courseId, setCourseId] = React.useState("");
  const [sort, setSort] = React.useState<CourseSort>("default");
  const [thumbF, setThumbF] = React.useState("");
  const [bufF, setBufF] = React.useState("");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [busyIds, setBusyIds] = React.useState<Set<number>>(new Set());
  const [drawer, setDrawer] = React.useState<CourseStatus | null>(null);

  const flatActive = tab === 1;
  const { rows: allRows, loaded, total } = useAllCourseVideos(flatActive ? courses : []);

  const perVid = data?.perVid ?? {};
  const courseStatus = React.useMemo(() => data?.courses ?? [], [data]);

  // 卡片视图：按搜索 / 课程下拉过滤
  const filteredCourses = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return courseStatus.filter((c) => {
      if (courseId && String(c.productId) !== courseId) return false;
      if (s && !c.name.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [courseStatus, q, courseId]);

  // 全部讲次视图：逐讲过滤
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
          id: r.v.videoId,
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

  // ---- 操作 ----
  const submit = async (vids: Video[], kind: "thumb" | "buffer") => {
    const t = kind === "thumb" ? vids.filter((v) => pickLow(v)) : vids.filter((v) => pickM3u8(v));
    if (!t.length) return toast("没有可处理的讲次");
    try {
      const r = kind === "thumb" ? await batchThumbs(t.map(MK_THUMB)) : await batchBuffer(t.map(MK_BUF));
      toast(`已加入队列 ${r.queued}（跳过 ${r.skipped}）`, { severity: "success" });
      refresh();
    } catch (e) {
      toast("提交失败：" + (e as Error).message, { severity: "error" });
    }
  };

  // 从有道同步观看状态：拉每门课的 playDuration/study，按「不回退、已学完为准」合并进本地进度。
  const doSyncYoudao = async () => {
    if (syncing) return;
    setSyncing(true);
    toast("正在从有道同步观看状态…");
    try {
      const r = await syncYoudaoProgress();
      const { created, updated, skipped } = r.videos;
      const failed = r.courses.failed
        ? `，${r.courses.failed} 门课失败`
        : "";
      toast(
        `同步完成：新增 ${created}、更新 ${updated} 讲（跳过 ${skipped}）${failed}`,
        { severity: r.courses.failed ? "warning" : "success" },
      );
      // 进度变了 → 重拉续看进度 + 课程状态（看得多/已看计数）。
      await Promise.all([mutate("/api/progress"), refresh()]);
    } catch (e) {
      toast("同步失败：" + (e as Error).message, { severity: "error" });
    } finally {
      setSyncing(false);
    }
  };

  const courseAction = async (c: CourseStatus, kind: "thumb" | "buffer") => {
    setBusyIds((s) => new Set(s).add(c.productId));
    try {
      const { videos } = await getCourseVideos(c.productId);
      await submit(videos.filter((v) => !v.locked), kind);
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(c.productId);
        return n;
      });
    }
  };

  const targets = (): Video[] => {
    if (selected.size) return allRows.filter((r) => selected.has(r.v.videoId)).map((r) => r.v);
    return gridRows.map((r) => r.vrow.v);
  };
  const rowThumb = (r: VideoRow) => submit([r.v], "thumb");
  const rowBuf = (r: VideoRow) => submit([r.v], "buffer");

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

  const loadingCourses = flatActive && total > 0 && loaded < total;

  return (
    <Box sx={{ maxWidth: 1240, mx: "auto", p: { xs: 1.5, md: 3 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "baseline" }}
        sx={{ mb: 1.5 }}
      >
        <Typography variant="h5" sx={{ flexShrink: 0 }}>设置 / 状态</Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ ml: { xs: 0, sm: 1.5 }, mt: { xs: 0.5, sm: 0 } }}
        >
          每门课的缓存 / 缩略图 / 观看进度，实时反映任何来源的缓存（观看、预缓存、手动、重启后残留）。
        </Typography>
      </Stack>

      {/* 顶部条：健康 + 存储 + 实时任务队列 */}
      <Card sx={{ p: 2, mb: 2, position: { md: "sticky" }, top: 8, zIndex: 2 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          divider={<Box sx={{ borderLeft: (t) => `1px solid ${t.palette.divider}` }} />}
        >
          <Box sx={{ flex: "0 0 auto", minWidth: 180 }}>
            <HealthBar health={data?.health} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <StorageStrip
              bufferBytes={data?.totals.bufferBytes ?? 0}
              bufferLimit={data?.totals.bufferLimit ?? 0}
              thumbBytes={data?.totals.thumbBytes ?? 0}
            />
          </Box>
          <Box sx={{ flex: 1.3, minWidth: 240 }}>
            <TaskQueuePanel
              tasks={data?.tasks ?? []}
              bps={bps.bps}
              series={bps.series}
              queue={data?.activity.queue ?? { thumb: 0, buffer: 0 }}
            />
          </Box>
        </Stack>
      </Card>

      {/* 缓存目录设置：查看 / 修改持久化目录，目录丢失时报错 */}
      <CacheDirCard
        cacheDir={data?.health.cacheDir ?? ""}
        cacheDirOk={data?.health.cacheDirOk ?? true}
        onSaved={refresh}
      />

      {/* AI 助教：系统提示词 + 默认思考等级 */}
      <AssistantCard />

      {/* 工具栏 */}
      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
          <TextField size="small" placeholder="搜索课程 / 讲次…" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 180 }} />
          <TextField size="small" select label="课程" value={courseId} onChange={(e) => setCourseId(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="">全部（{courses.length}）</MenuItem>
            {courses.map((c) => (
              <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>
            ))}
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
          <Stack direction="row" sx={{ ml: { md: "auto" }, flexWrap: "wrap", gap: 1, alignItems: "center" }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={prefs.density}
              onChange={(_e, v) => v && setPrefs({ density: v })}
              sx={{
                borderRadius: (t) => t.radius.full,
                overflow: "hidden",
                "& .MuiToggleButtonGroup-grouped": {
                  border: 0,
                  borderRadius: 0,
                },
              }}
            >
              <ToggleButton value="comfortable">宽松</ToggleButton>
              <ToggleButton value="compact">紧凑</ToggleButton>
            </ToggleButtonGroup>
            <Button variant="text" onClick={doSyncYoudao} disabled={syncing}>
              {syncing ? "同步中…" : "从有道同步观看"}
            </Button>
            <Button variant="contained" onClick={() => submit(targets(), "thumb")}>生成缩略图</Button>
            <Button variant="outlined" onClick={() => submit(targets(), "buffer")}>缓冲整集</Button>
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
              ? selected.size
                ? `已选 ${selected.size}`
                : `${gridRows.length} 讲${loadingCourses ? `（加载中 ${loaded}/${total}）` : ""}`
              : `${filteredCourses.length} / ${courseStatus.length} 门课`}
          </Typography>
        </Stack>
      </Card>

      {tab === 0 ? (
        <CourseStatusGrid
          courses={filteredCourses}
          loading={!data}
          sort={sort}
          busyIds={busyIds}
          onOpen={setDrawer}
          onBuffer={(c) => courseAction(c, "buffer")}
          onThumbs={(c) => courseAction(c, "thumb")}
        />
      ) : (
        <Card sx={{ p: 0, height: { xs: "calc(100vh - 320px)", md: "min(72vh, 820px)" }, minHeight: 420, overflow: "hidden" }}>
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
