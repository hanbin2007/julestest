"use client";
import * as React from "react";
import { Box, Button, Skeleton, Stack, Typography } from "@mui/material";
import ReportGmailerrorredRoundedIcon from "@mui/icons-material/ReportGmailerrorredRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";

// 统一的数据边缘态原语:出错→行内重试面板、加载→骨架、空→设计空态、有数据→children。
// 一处定义、处处复用——根治"loading/error/empty 三态塌成同一个空态"(失败被当成数据丢失)的病根。
// 用法约定:调用方仅在「无可展示数据」时才传入 error/loading,有旧数据时照常渲染 children(保留陈旧数据)。
export function DataBoundary({
  loading,
  error,
  isEmpty,
  skeleton,
  empty,
  onRetry,
  errorTitle = "加载失败",
  errorHint,
  children,
}: {
  loading?: boolean;
  error?: unknown;
  isEmpty?: boolean;
  skeleton?: React.ReactNode;
  empty?: React.ReactNode;
  onRetry?: () => void;
  errorTitle?: string;
  errorHint?: string;
  children: React.ReactNode;
}) {
  if (error) {
    return (
      <Stack alignItems="center" spacing={1.5} sx={{ py: 8, color: "text.secondary" }}>
        <ReportGmailerrorredRoundedIcon sx={{ fontSize: 48, color: "error.main", opacity: 0.85 }} />
        <Typography variant="body2" color="text.primary">{errorTitle}</Typography>
        <Typography variant="caption">{errorHint ?? "请检查网关 / 网络后重试。"}</Typography>
        {onRetry && (
          <Button onClick={onRetry} startIcon={<RefreshRoundedIcon />} size="small" variant="outlined" sx={{ mt: 0.5 }}>
            重试
          </Button>
        )}
      </Stack>
    );
  }
  if (loading) {
    return (
      <>
        {skeleton ?? (
          <Stack spacing={1.5} sx={{ maxWidth: 480, mx: "auto", py: 6 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} variant="rounded" height={56} sx={{ borderRadius: (t) => t.radius.md }} />
            ))}
          </Stack>
        )}
      </>
    );
  }
  if (isEmpty) return <Box>{empty ?? null}</Box>;
  return <>{children}</>;
}
