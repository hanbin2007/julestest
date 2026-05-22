"use client";
import { Box, Card, LinearProgress, Stack, Typography } from "@mui/material";
import PlayCircleFilledRoundedIcon from "@mui/icons-material/PlayCircleFilledRounded";
import { motion } from "framer-motion";
import { useProgressMap } from "@/hooks/persist";
import { hashSeed } from "@/lib/color";
import { fmtDur } from "@/lib/media";

export default function ContinueWatchingRail({
  onResume,
}: {
  onResume: (productId: number, videoId: number) => void;
}) {
  const map = useProgressMap();
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
          const color = hashSeed(e.courseName ?? "");
          const ratio = Math.min(1, e.t / e.d);
          return (
            <motion.div key={e.videoId} whileHover={{ y: -3 }} style={{ flex: "0 0 auto" }}>
              <Card
                onClick={() => onResume(e.productId!, e.videoId!)}
                sx={{ width: 240, p: 1.5, cursor: "pointer", borderColor: color }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                  <PlayCircleFilledRoundedIcon sx={{ color }} />
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {e.courseName}
                  </Typography>
                </Box>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 600, mb: 1, height: 40, overflow: "hidden", lineHeight: 1.3 }}
                >
                  {e.title}
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
            </motion.div>
          );
        })}
      </Stack>
    </Box>
  );
}
