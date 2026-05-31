"use client";
import * as React from "react";
import {
  Box,
  Button,
  Card,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import PauseCircleOutlineRoundedIcon from "@mui/icons-material/PauseCircleOutlineRounded";
import { useSWRConfig } from "swr";
import { useCourses, useAllCourseVideos, useCoursesStatus, markRecentAction } from "@/hooks/data";
import { usePrefs } from "@/hooks/persist";
import { useToast } from "@/components/common/Toast";
import LectureGrid, { type GridRow } from "./LectureGrid";
import StorageStrip from "./StorageStrip";
import TaskQueuePanel from "./TaskQueuePanel";
import SettingsStatusBar from "./SettingsStatusBar";
import SectionHeader from "./SectionHeader";
import CacheDirCard from "./CacheDirCard";
import AssistantCard from "./AssistantCard";
import CourseStatusGrid, { type CourseSort } from "./CourseStatusGrid";
import CourseDetailDrawer from "./CourseDetailDrawer";
import { batchThumbs, batchBuffer, bgPause, getCourseVideos, syncYoudaoProgress, taskAction } from "@/lib/api";
import { pickLow, pickM3u8 } from "@/lib/media";
import type { CoursesStatus, CourseStatus, TaskItem, TaskState, TaskVerb, Video, VideoRow } from "@/types/api";

// 操作成功后的人话反馈（按 verb 映射）：暂停/继续/取消/重试 都给即时 toast，避免「点了没反应」。
const VERB_DONE: Record<TaskVerb, string> = {
  pause: "已暂停",
  resume: "已继续",
  cancel: "已取消",
  retry: "已重试",
  dismiss: "已清除",
};

// 缩略图源：点播取最低清晰度（解码更快）；直播回放无清晰度档 → 回退到 m3u8 (即 downloadUrl)。
// liveId 给网关拼 Liveid 头取 AES key；点播为 null。
const thumbSrc = (v: Video) => pickLow(v) || pickM3u8(v) || "";
const MK_THUMB = (v: Video) => ({
  videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
  productId: v.productId, duration: v.duration, src: thumbSrc(v),
  liveId: v.liveId ?? null,
});
const MK_BUF = (v: Video) => ({
  videoId: v.videoId, contentId: v.contentId, cardPackageId: v.cardPackageId,
  productId: v.productId, src: pickM3u8(v) ?? "",
  liveId: v.liveId ?? null,
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
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = React.useState<Set<number>>(new Set());
  const [drawer, setDrawer] = React.useState<CourseStatus | null>(null);
  const [tasksFsOpen, setTasksFsOpen] = React.useState(false);
  const [bgBusy, setBgBusy] = React.useState(false);
  const bgPaused = !!data?.health.bgPaused;

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

  // ---- 操作 ----
  // 去抖：拦截在途的重复提交(网格行/批量按钮连点 → 多个 POST)。课程卡按钮另由 busyIds 禁用。
  const submittingRef = React.useRef(false);
  const submit = async (vids: Video[], kind: "thumb" | "buffer") => {
    const t = kind === "thumb" ? vids.filter((v) => thumbSrc(v)) : vids.filter((v) => pickM3u8(v));
    if (!t.length) return toast("没有可处理的讲次");
    if (submittingRef.current) return; // 连点去抖：在途提交未结束时忽略重复点击
    submittingRef.current = true;
    try {
      const r = kind === "thumb" ? await batchThumbs(t.map(MK_THUMB)) : await batchBuffer(t.map(MK_BUF));
      markRecentAction(); // 批量提交也算一次动作 → 状态轮询提速到 1s，让排队/进行中立即可见。
      // 跳过原因汇总：把 { [vid]: 原因 } 反向聚成 { 原因: 计数 }，告诉用户「哪几讲为何没排进去」而非只报数字。
      const reasons = r.skippedReasons ?? {};
      const byReason = new Map<string, number>();
      for (const why of Object.values(reasons)) byReason.set(why, (byReason.get(why) ?? 0) + 1);
      const reasonText =
        byReason.size > 0
          ? "（跳过：" + Array.from(byReason.entries()).map(([why, n]) => `${why} ${n}`).join("、") + "）"
          : r.skipped > 0
            ? `（跳过 ${r.skipped}）`
            : "";
      // 全部被跳过(无新入队)时给 info/warning，避免「已加入队列 0」让人误以为成功；有入队则 success。
      toast(`已加入队列 ${r.queued}${reasonText}`, {
        severity: r.queued > 0 ? "success" : r.skipped > 0 ? "warning" : "info",
      });
      refresh();
    } catch (e) {
      toast("提交失败：" + (e as Error).message, { severity: "error" });
    } finally {
      submittingRef.current = false;
    }
  };

  // 任务操作（暂停/继续/取消/重试）：buffer/thumb/prefetch 均可控（prefetch 不支持 retry）。
  // 关键：不丢弃 TaskActionResult——成功即按返回的真实 state 乐观回填该任务行 + 人话 toast；
  // 失败则弹网关给的人话 reason（绝不再用泛化「操作未生效」）。markRecentAction 让轮询提速到 1s
  // 兜底确认，refresh 触发一次即时重拉。
  const handleTaskAction = async (task: TaskItem, verb: TaskVerb) => {
    markRecentAction(); // 无论成败都标记：让轮询在接下来 ~4s 提速到 1s，捕捉状态迁移。
    let res;
    try {
      res = await taskAction(task.kind, task.vid, verb);
    } catch (e) {
      // 真·网络/解析失败（非 409 业务否决）。靠刷新兜底，给可见错误。
      toast("操作失败：" + (e as Error).message, { severity: "error" });
      refresh();
      return;
    }
    if (res.ok) {
      // 乐观回填：把该任务行的 state 立即换成网关复查后返回的真实 state（不等 1s 轮询）。
      // res.state 可能为 null（如 cancel 后任务移出进行中列表）；此时不强行改 state，靠 refresh 拉走它。
      const newState = res.state as TaskState | null;
      if (newState) {
        refresh(
          (cur: CoursesStatus | undefined) => {
            if (!cur) return cur;
            const patch = (arr: TaskItem[]) =>
              arr.map((t) => (t.kind === task.kind && t.vid === task.vid ? { ...t, state: newState } : t));
            return { ...cur, tasks: patch(cur.tasks) };
          },
          { revalidate: false },
        );
      }
      toast(VERB_DONE[verb], { severity: "success" });
    } else {
      // 网关人话否决（HTTP 409 / 400）：直接展示 reason；没有 reason 时给保守提示。
      toast(res.reason || "操作未生效，任务状态可能已变化", { severity: "warning" });
    }
    refresh(); // 即时重拉确认真实态（乐观回填只是抢在轮询前的临时态）。
  };

  // 全局后台缓存开关：暂停/恢复 buffer/thumb/prefetch 三 worker。乐观回填 health.bgPaused，
  // 失败回滚 + 错误 toast。网关持久化 bg_state.json，跨重启保留。
  const toggleBgPause = async (next: boolean) => {
    if (bgBusy) return;
    setBgBusy(true);
    refresh(
      (cur: CoursesStatus | undefined) =>
        cur ? { ...cur, health: { ...cur.health, bgPaused: next } } : cur,
      { revalidate: false },
    );
    try {
      const r = await bgPause(next);
      toast(r.paused ? "已暂停所有后台缓存" : "已恢复后台缓存", { severity: "success" });
    } catch (e) {
      toast("切换失败：" + (e as Error).message, { severity: "error" });
    } finally {
      setBgBusy(false);
      refresh();
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
    if (selected.size) return allRows.filter((r) => selected.has(`${r.courseId}:${r.v.videoId}`)).map((r) => r.v);
    return gridRows.map((r) => r.vrow.v);
  };
  const rowThumb = (r: VideoRow) => submit([r.v], "thumb");
  const rowBuf = (r: VideoRow) => submit([r.v], "buffer");

  const toggle = (id: string, on: boolean) =>
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

      <SectionHeader title="系统状态" hint="网关连通性 · 下载速率 · 任务进度" />

      {/* 贴顶状态条：被动状态 + 速率 + 任务徽标（完整任务管理在下方区） */}
      <SettingsStatusBar
        health={data?.health}
        bps={bps.bps}
        series={bps.series}
        working={(data?.tasks ?? []).filter((t) => t.state === "working").length}
        onOpenTasks={() => setTasksFsOpen(true)}
      />

      {/* 全局后台缓存开关：一处暂停 buffer/thumb/prefetch 三 worker（网关持久化、跨重启保留）。 */}
      <Card sx={{ p: 2, mb: 2, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5 }}>
        <PauseCircleOutlineRoundedIcon
          sx={{ fontSize: 20, color: bgPaused ? "warning.main" : "text.disabled" }}
        />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            暂停所有后台缓存
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {bgPaused
              ? "已暂停：缓冲 / 缩略图 / 预缓存全部停工（不丢已缓存片段），重启后仍保持暂停"
              : "正常：后台按优先级自动缓冲 / 生成缩略图 / 预缓存"}
          </Typography>
        </Box>
        <Tooltip title={data?.health.gatewayOnline ? "" : "网关离线，无法切换"}>
          <span>
            <FormControlLabel
              sx={{ m: 0 }}
              labelPlacement="start"
              control={
                <Switch
                  color="warning"
                  checked={bgPaused}
                  disabled={bgBusy || !data?.health.gatewayOnline}
                  onChange={(_e, v) => toggleBgPause(v)}
                  inputProps={{ "aria-label": "暂停所有后台缓存" }}
                />
              }
              label={
                <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                  {bgPaused ? "已暂停" : "运行中"}
                </Typography>
              }
            />
          </span>
        </Tooltip>
      </Card>

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
          <Stack direction="row" sx={{ ml: { md: "auto" }, flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
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

      <SectionHeader title="缓存管理" hint="存储占用 · 任务队列 · 逐课缓存状态" />

      {/* 缓存管理：存储占用 + 完整任务队列（移出贴顶卡，给主网格让出竖向空间） */}
      <Card sx={{ p: 2, mb: 2 }}>
        <StorageStrip
          bufferBytes={data?.totals.bufferBytes ?? 0}
          bufferLimit={data?.totals.bufferLimit ?? 0}
          thumbBytes={data?.totals.thumbBytes ?? 0}
        />
        <Box sx={{ mt: 2 }}>
          <TaskQueuePanel
            tasks={data?.tasks ?? []}
            failedTasks={data?.failedTasks ?? []}
            allTasks={data?.allTasks ?? []}
            queue={data?.activity.queue ?? { thumb: 0, buffer: 0 }}
            onAction={handleTaskAction}
            fsOpen={tasksFsOpen}
            onFsOpenChange={setTasksFsOpen}
          />
        </Box>
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
        <Card sx={{ p: 0, height: { xs: "calc(100dvh - 320px)", md: "min(72dvh, 820px)" }, minHeight: 420, overflow: "hidden" }}>
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

      {/* 缓存目录：查看 / 修改持久化目录（移到缓存网格之后，不打断主扫读） */}
      <CacheDirCard
        cacheDir={data?.health.cacheDir ?? ""}
        cacheDirOk={data?.health.cacheDirOk ?? true}
        onSaved={refresh}
      />

      <SectionHeader title="其他设置" hint="与缓存无关的偏好" />
      {/* AI 助教：系统提示词 + 默认思考等级（与缓存无关，移到最后避免打断缓存扫读） */}
      <AssistantCard />
    </Box>
  );
}
