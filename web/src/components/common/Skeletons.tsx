"use client";
import { Box, Skeleton, Stack } from "@mui/material";

export function SidebarSkeleton() {
  return (
    <Stack spacing={1} sx={{ p: 1.5 }}>
      {Array.from({ length: 10 }).map((_, i) => (
        <Skeleton key={i} variant="rounded" height={44} sx={{ borderRadius: (t) => t.radius.sm }} />
      ))}
    </Stack>
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 1.5 }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} variant="rounded" height={150} sx={{ borderRadius: (t) => t.radius.md }} />
      ))}
    </Box>
  );
}

export function PlayerSkeleton() {
  return (
    <Box sx={{ width: "100%", maxWidth: 1100, mx: "auto" }}>
      <Skeleton variant="rounded" sx={{ width: "100%", aspectRatio: "16/9", borderRadius: (t) => t.radius.lg }} />
      <Skeleton variant="text" width="50%" height={36} sx={{ mt: 2 }} />
      <Skeleton variant="text" width="30%" />
    </Box>
  );
}
