"use client";
import { Box, Typography } from "@mui/material";
import { PieChart } from "@mui/x-charts/PieChart";
import { fmtBytes } from "@/lib/media";

export default function StorageDonut({ used, limit }: { used: number; limit: number }) {
  const free = Math.max(0, limit - used);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
      <PieChart
        series={[
          {
            innerRadius: 46,
            outerRadius: 70,
            paddingAngle: 2,
            cornerRadius: 4,
            data: [
              { id: 0, value: used, label: "已用", color: "#4f8cff" },
              { id: 1, value: free, label: "空闲", color: "#2b3340" },
            ],
          },
        ]}
        width={170}
        height={160}
        hideLegend
      />
      <Box>
        <Typography variant="h6">{fmtBytes(used)}</Typography>
        <Typography variant="caption" color="text.secondary">
          缓冲缓存已用 / 上限 {fmtBytes(limit)}
        </Typography>
      </Box>
    </Box>
  );
}
