"use client";
import Link from "next/link";
import { Box, Card, Typography } from "@mui/material";
import { alpha, keyframes } from "@mui/material/styles";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { useSettingsData } from "./SettingsDataContext";
import { smoothColors } from "@/theme/motion";

// 不确定态斜纹（流动）：周期位移 = 9px/18px·45° 条纹的一个完整周期(25.456px)，无缝循环。
const flow = keyframes`from { background-position: 0 0; } to { background-position: 25.456px 0; }`;

// 概览当前活动卡：正在缓存哪讲（+不确定斜纹条）· 队列深度 · N进行中·M失败（链到任务页）。
export default function ActivityCard() {
  const { data } = useSettingsData();
  const a = data?.activity;
  const working = data?.tasks.length ?? 0;
  const failed = data?.failedTasks.length ?? 0;
  const dl = a?.downloadingVid != null;
  return (
    <Card sx={{ p: 2.25, height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="body2" color="text.secondary">正在缓存</Typography>
        <Typography variant="body2" sx={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {dl ? `${a?.title ?? `第 ${a?.downloadingVid} 讲`} · 进行中` : "空闲"}
        </Typography>
      </Box>
      {dl && (
        <Box
          sx={{
            height: 8,
            borderRadius: (t) => t.radius.full,
            overflow: "hidden",
            my: 1,
            backgroundImage: (t) =>
              `repeating-linear-gradient(45deg, ${t.palette.primary.main} 0 9px, ${alpha(t.palette.primary.main, 0.5)} 9px 18px)`,
            animation: `${flow} .9s linear infinite`,
          }}
        />
      )}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", py: 1 }}>
        <Typography variant="body2" color="text.secondary">队列深度</Typography>
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
          缓冲 {a?.queue.buffer ?? 0} · 缩略图 {a?.queue.thumb ?? 0}
        </Typography>
      </Box>
      <Box
        component={Link}
        href="/settings/tasks"
        sx={{
          mt: "auto",
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 1.25,
          borderRadius: (t) => t.radius.md,
          bgcolor: "md3.surfaceContainerHigh",
          transition: (t) => smoothColors(t, ["background-color"]),
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography variant="body2">
          {working} 进行中
          {failed > 0 ? (
            <Box component="span" sx={{ color: "error.main", fontWeight: 700 }}> · {failed} 失败</Box>
          ) : null}
        </Typography>
        <Box sx={{ ml: "auto", display: "flex", alignItems: "center", color: "text.disabled" }}>
          前往任务页 <ChevronRightRoundedIcon sx={{ fontSize: 18 }} />
        </Box>
      </Box>
    </Card>
  );
}
