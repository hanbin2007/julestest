"use client";
import * as React from "react";
import { Box, Button, Card, Typography } from "@mui/material";
import { AnimatePresence, motion } from "framer-motion";
import { DUR } from "@/theme/motion";
import type { Video } from "@/types/api";

export default function UpNextCountdown({
  next,
  onPlay,
  onCancel,
}: {
  next: Video | null;
  onPlay: () => void;
  onCancel: () => void;
}) {
  const [left, setLeft] = React.useState(5);
  React.useEffect(() => {
    if (!next) return;
    setLeft(5);
    const id = setInterval(() => setLeft((x) => x - 1), 1000);
    return () => clearInterval(id);
  }, [next]);
  React.useEffect(() => {
    if (next && left <= 0) onPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, next]);

  return (
    <AnimatePresence>
      {next && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: "tween", duration: DUR.long / 1000, ease: [0.2, 0, 0, 1] }}
          style={{ position: "absolute", right: 16, bottom: 16, zIndex: 20 }}
        >
          <Card sx={{ p: 2, width: 300, bgcolor: "md3.surfaceContainerHigh" }}>
            <Typography variant="caption" color="text.secondary">
              {left} 秒后播放下一讲
            </Typography>
            <Typography variant="subtitle1" sx={{ mt: 0.5, mb: 1.5, lineHeight: 1.3 }}>
              {next.title ?? `视频 ${next.videoId}`}
            </Typography>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button size="small" variant="contained" onClick={onPlay}>
                立即播放
              </Button>
              <Button size="small" variant="text" onClick={onCancel}>
                取消
              </Button>
            </Box>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
