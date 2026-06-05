"use client";
import { Box, Card, LinearProgress, Stack, Typography } from "@mui/material";
import PlayCircleFilledRoundedIcon from "@mui/icons-material/PlayCircleFilledRounded";
import { useProgressMap } from "@/hooks/persist";
import { useCourses } from "@/hooks/data";
import { hashSeed } from "@/lib/color";
import { fmtDur } from "@/lib/media";
import { hoverElevate } from "@/theme/motion";

export default function ContinueWatchingRail({
  onResume,
}: {
  onResume: (productId: number, videoId: number) => void;
}) {
  const map = useProgressMap();
  // 课程可能被改名：用实时课程列表解析显示名，避免显示写入时的旧快照。
  const { courses } = useCourses();
  const nameById = new Map(courses.map((c) => [c.id, c.name]));
  const items = Object.values(map)
    .filter((e) => e.productId && e.videoId && e.d && e.t / e.d > 0.02 && e.t / e.d < 0.95)
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);
  if (!items.length) return null;
  return (
    <Box sx={{ width: "100%", maxWidth: 1100, mx: "auto", mb: 1 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
        继续观看
      </Typography>
      <Stack direction="row" spacing={1.5} sx={{ overflowX: "auto", pb: 1 }}>
        {items.map((e) => {
          // filter 已保证 productId/videoId 为真值，此处兜底取值（不再用 ! 断言可选字段）。
          const productId = e.productId ?? 0;
          const videoId = e.videoId ?? 0;
          // 配色用写入时的课程名快照，保证同一条目颜色稳定（改名也不跳色）。
          const color = hashSeed(e.courseName ?? `视频 ${videoId}`);
          // 显示名优先用实时课程列表，改名即时反映；兜底用快照名再兜底"课程"。
          const courseName = nameById.get(productId) ?? e.courseName ?? "课程";
          const title = e.title ?? `视频 ${videoId}`;
          const ratio = Math.min(1, e.t / e.d);
          return (
            <Box key={`${productId}:${videoId}`} sx={{ flex: "0 0 auto" }}>
              <Card
                onClick={() => onResume(productId, videoId)}
                sx={(t) => ({ ...hoverElevate(t), width: 240, p: 2, cursor: "pointer", borderColor: color })}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                  <PlayCircleFilledRoundedIcon sx={{ color }} />
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {courseName}
                  </Typography>
                </Box>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 600, mb: 1, height: 40, overflow: "hidden", lineHeight: 1.3 }}
                >
                  {title}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={ratio * 100}
                  sx={{ "& .MuiLinearProgress-bar": { bgcolor: color } }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
                  {fmtDur(e.t)} / {fmtDur(e.d)}
                </Typography>
              </Card>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
