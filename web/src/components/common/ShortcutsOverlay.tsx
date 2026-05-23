"use client";
import { Box, Dialog, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";

const ROWS: [string, string][] = [
  ["空格 / K", "播放 / 暂停"],
  ["← / →", "后退 / 前进 5 秒"],
  ["J / L", "后退 / 前进 10 秒"],
  ["↑ / ↓", "音量 +/-"],
  ["[ / ]", "倍速 -/+"],
  ["0–9", "跳到 0%–90%"],
  ["N / P", "下一讲 / 上一讲"],
  ["M", "静音"],
  ["F", "全屏"],
  ["B", "在当前时间记笔记"],
  ["C", "复制下载命令"],
  ["⌘K / Ctrl+K", "命令面板（搜索讲次）"],
  ["?", "显示此快捷键表"],
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        px: 1,
        py: 0.5,
        borderRadius: (t) => t.radius.xs,
        bgcolor: "md3.surfaceContainerHighest",
        border: (t) => `1px solid ${t.palette.divider}`,
        fontSize: 12,
        fontFamily: "monospace",
      }}
    >
      {children}
    </Box>
  );
}

export default function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: (t) => t.radius.lg } }}>
      <DialogTitle>键盘快捷键</DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          {ROWS.map(([k, d]) => (
            <Box key={k} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box sx={{ width: 130 }}>
                <Kbd>{k}</Kbd>
              </Box>
              <Typography variant="body2" color="text.secondary">
                {d}
              </Typography>
            </Box>
          ))}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
