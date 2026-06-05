"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Box,
  Button,
  Card,
  Chip,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import { useAllChats } from "@/hooks/useAllChats";
import { DataBoundary } from "@/components/common/DataBoundary";
import { CardGridSkeleton } from "@/components/common/Skeletons";
import { useToast } from "@/components/common/Toast";
import { hashSeed } from "@/lib/color";
import { StatNum } from "@/components/common/StatNum";
import { StatusDot } from "@/components/common/StatusDot";
import type { EnrichedChat } from "@/lib/store";
import ChatCard from "./ChatCard";
import ChatOverlay from "./ChatOverlay";

type Sort = "recent" | "created";
type KindFilter = "all" | "lesson" | "independent";

const GRID_SX = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
  gridAutoRows: "1fr",
  gap: 1.5,
} as const;

export default function ChatsView() {
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const { chats, stats, create, rename, remove, error, isLoading, refresh } = useAllChats();
  const [q, setQ] = React.useState("");
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [courseId, setCourseId] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("recent");
  const [overlay, setOverlay] = React.useState<{ open: boolean; chatId: string | null }>({ open: false, chatId: null });

  // 深链 ?open=<id>:进来即在 overlay 里打开该 chat(切换器里「新建独立对话」走的就是这条路径)。
  // 一次性消费,剥掉 query 避免刷新再触发。
  React.useEffect(() => {
    const id = sp?.get("open");
    if (!id) return;
    setOverlay({ open: true, chatId: id });
    const url = new URL(window.location.href);
    url.searchParams.delete("open");
    window.history.replaceState({}, "", url.toString());
  }, [sp]);

  // 课程下拉项(只列 lesson 类 + 有 courseName 的)。去重按 courseId。
  const courseOptions = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const c of chats) {
      if (c.kind === "lesson" && c.productId != null && c.courseName && !m.has(c.productId)) {
        m.set(c.productId, c.courseName);
      }
    }
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [chats]);

  // 过滤
  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return chats.filter((c) => {
      if (kind === "lesson" && c.kind !== "lesson") return false;
      if (kind === "independent" && c.kind !== "independent") return false;
      if (courseId && String(c.productId ?? "") !== courseId) return false;
      if (s) {
        const hay = [
          c.title ?? "",
          c.lastMessage?.text ?? "",
          c.courseName ?? "",
          c.lessonTitle ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [chats, q, kind, courseId]);

  // 分组:独立单独一组在最前;其余按课程分,组内按 sort 排,组按最新活动排。
  const groups = React.useMemo(() => {
    const independents = filtered.filter((c) => c.kind === "independent");
    const lessons = filtered.filter((c) => c.kind === "lesson" && c.productId != null);
    const map = new Map<number, { courseId: number; courseName: string; items: EnrichedChat[] }>();
    for (const c of lessons) {
      const cid = c.productId!;
      const g = map.get(cid) ?? { courseId: cid, courseName: c.courseName ?? `课程 ${cid}`, items: [] };
      g.items.push(c);
      map.set(cid, g);
    }
    const sortItems = (arr: EnrichedChat[]) =>
      arr.sort((a, b) => (sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
    const courseGroups = [...map.values()];
    for (const g of courseGroups) sortItems(g.items);
    courseGroups.sort(
      (a, b) =>
        Math.max(...b.items.map((i) => i.updatedAt), 0) -
        Math.max(...a.items.map((i) => i.updatedAt), 0),
    );
    return { independents: sortItems(independents), courseGroups };
  }, [filtered, sort]);

  const shownCount = groups.independents.length + groups.courseGroups.reduce((a, g) => a + g.items.length, 0);

  const openChat = (chat: EnrichedChat) => {
    if (chat.kind === "lesson" && chat.productId != null && chat.videoId != null) {
      router.push(`/?productId=${chat.productId}&videoId=${chat.videoId}&chat=${encodeURIComponent(chat.id)}`);
    } else {
      setOverlay({ open: true, chatId: chat.id });
    }
  };

  const onCreateIndependent = async () => {
    const c = await create("independent");
    setOverlay({ open: true, chatId: c.id });
  };

  const doRename = async (id: string, title: string) => {
    try {
      await rename(id, title);
    } catch (e) {
      toast("重命名失败:" + (e as Error).message, { severity: "error" });
    }
  };

  const doDelete = async (id: string) => {
    try {
      await remove(id);
      toast("已删除", { severity: "success" });
    } catch (e) {
      toast("删除失败:" + (e as Error).message, { severity: "error" });
    }
  };

  return (
    <Box sx={{ maxWidth: 1240, mx: "auto", p: { xs: 1.5, md: 3 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "baseline" }}
        sx={{ mb: 1.5 }}
      >
        <Typography variant="h5" sx={{ flexShrink: 0 }}>
          对话
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ ml: { xs: 0, sm: 1.5 }, mt: { xs: 0.5, sm: 0 } }}
        >
          AI 助教的全部对话,按课程分组;独立对话在这里全屏阅读,讲绑定对话点开跳回播放器。
        </Typography>
      </Stack>

      {/* 统计概览(粘顶) */}
      <Card sx={{ p: 2, mb: 2, position: { md: "sticky" }, top: 8, zIndex: 2 }}>
        <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", alignItems: "center", rowGap: 1 }}>
          <StatNum value={stats.total} label="个对话" />
          <StatNum value={stats.lesson} label="跟讲" />
          <StatNum value={stats.independent} label="独立" />
          <StatNum value={stats.courses} label="门课程" />
          {shownCount !== stats.total && (
            <Typography variant="caption" color="text.secondary">
              · 当前筛选 {shownCount} 个
            </Typography>
          )}
        </Stack>
      </Card>

      {/* 工具栏 */}
      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
          <TextField
            size="small"
            placeholder="搜索标题 / 最近消息 / 课程…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            sx={{ flex: 1, minWidth: 180 }}
          />
          <TextField
            size="small"
            select
            label="类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as KindFilter)}
            sx={{ minWidth: 110 }}
          >
            <MenuItem value="all">全部</MenuItem>
            <MenuItem value="lesson">跟讲</MenuItem>
            <MenuItem value="independent">独立</MenuItem>
          </TextField>
          {kind !== "independent" && (
            <TextField
              size="small"
              select
              label="课程"
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              sx={{ minWidth: 150 }}
              disabled={courseOptions.length === 0}
            >
              <MenuItem value="">全部({courseOptions.length})</MenuItem>
              {courseOptions.map((c) => (
                <MenuItem key={c.id} value={String(c.id)}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            size="small"
            select
            label="排序"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            sx={{ minWidth: 120 }}
          >
            <MenuItem value="recent">最近活动</MenuItem>
            <MenuItem value="created">创建时间</MenuItem>
          </TextField>
          <Stack direction="row" sx={{ ml: { md: "auto" }, gap: 1 }}>
            <Button
              variant="contained"
              startIcon={<AddRoundedIcon />}
              onClick={onCreateIndependent}
            >
              新建独立对话
            </Button>
          </Stack>
        </Stack>
      </Card>

      {chats.length === 0 ? (
        <DataBoundary
          loading={isLoading}
          error={error}
          isEmpty={!isLoading && !error}
          onRetry={() => refresh()}
          skeleton={<CardGridSkeleton />}
          empty={
            <Stack alignItems="center" spacing={1} sx={{ py: 8, color: "text.secondary" }}>
              <ForumOutlinedIcon sx={{ fontSize: 48, opacity: 0.5 }} />
              <Typography variant="body2">还没有任何对话。</Typography>
              <Typography variant="caption">
                在看课页打开 AI 助教开始一段,或点上方「新建独立对话」。
              </Typography>
            </Stack>
          }
        >
          {null}
        </DataBoundary>
      ) : shownCount === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: "center" }}>
          无匹配对话
        </Typography>
      ) : (
        <>
          {groups.independents.length > 0 && (
            <Box sx={{ mb: 3 }}>
              <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 1.5 }}>
                <StatusDot color="text.disabled" size={10} />
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  独立对话
                </Typography>
                <Chip size="small" variant="outlined" label={groups.independents.length} sx={{ height: 22 }} />
              </Stack>
              <Box sx={GRID_SX}>
                {groups.independents.map((c) => (
                  <ChatCard
                    key={c.id}
                    chat={c}
                    onOpen={openChat}
                    onRename={doRename}
                    onDelete={doDelete}
                  />
                ))}
              </Box>
            </Box>
          )}
          {groups.courseGroups.map((g) => {
            const color = hashSeed(g.courseName);
            return (
              <Box key={g.courseId} sx={{ mb: 3 }}>
                <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 1.5 }}>
                  <StatusDot color={color} size={10} />
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: 0 }} noWrap title={g.courseName}>
                    {g.courseName}
                  </Typography>
                  <Chip size="small" variant="outlined" label={g.items.length} sx={{ height: 22 }} />
                </Stack>
                <Box sx={GRID_SX}>
                  {g.items.map((c) => (
                    <ChatCard
                      key={c.id}
                      chat={c}
                      onOpen={openChat}
                      onRename={doRename}
                      onDelete={doDelete}
                    />
                  ))}
                </Box>
              </Box>
            );
          })}
        </>
      )}

      <ChatOverlay
        open={overlay.open}
        chatId={overlay.chatId}
        onClose={() => setOverlay({ open: false, chatId: null })}
      />
    </Box>
  );
}
