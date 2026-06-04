"use client";
// 路由段错误边界:任一客户端组件渲染抛错时兜底,避免白屏。
import { Box, Button, Stack, Typography } from "@mui/material";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import ReportGmailerrorredRoundedIcon from "@mui/icons-material/ReportGmailerrorredRounded";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "60vh", p: 3 }}>
      <Stack alignItems="center" spacing={1.5} sx={{ color: "text.secondary", textAlign: "center" }}>
        <ReportGmailerrorredRoundedIcon sx={{ fontSize: 56, color: "error.main", opacity: 0.85 }} />
        <Typography variant="h6" color="text.primary">这一页出错了</Typography>
        <Typography variant="caption" sx={{ maxWidth: 420, wordBreak: "break-word" }}>
          {error?.message || "渲染时发生异常。"}
        </Typography>
        <Button onClick={reset} startIcon={<RefreshRoundedIcon />} variant="outlined" sx={{ mt: 1 }}>
          重试
        </Button>
      </Stack>
    </Box>
  );
}
