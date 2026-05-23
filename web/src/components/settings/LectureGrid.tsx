"use client";
import * as React from "react";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { Box, Button, Checkbox, Chip, LinearProgress, Typography } from "@mui/material";
import OndemandVideoRoundedIcon from "@mui/icons-material/OndemandVideoRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import { fmtDur, fmtBytes } from "@/lib/media";
import type { VideoRow } from "@/types/api";

export interface GridRow {
  id: number;
  courseName: string;
  title: string;
  duration: number | null;
  kind: "vod" | "live";
  bytes: number;
  thumbState: "ready" | "gen" | "error" | "none";
  bufCached: number;
  bufTotal: number | null;
  bufState: string | null;
  vrow: VideoRow;
}

const thumbRank = { ready: 3, gen: 2, error: 1, none: 0 } as const;

function ThumbChip({ s }: { s: GridRow["thumbState"] }) {
  if (s === "ready") return <Chip size="small" color="success" label="✓ 已生成" />;
  if (s === "gen") return <Chip size="small" color="primary" label="⏳ 生成中" />;
  if (s === "error") return <Chip size="small" color="error" label="✗ 失败" />;
  return <Chip size="small" label="— 未生成" />;
}

function BufferCell({ r }: { r: GridRow }) {
  if (r.bufState === "working") return <Chip size="small" color="primary" label="⏳ 缓冲中" />;
  if (r.bufState === "error") return <Chip size="small" color="error" label="✗ 失败" />;
  if (r.bufTotal) {
    const pct = Math.round((r.bufCached / r.bufTotal) * 100);
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
        <LinearProgress variant="determinate" value={pct} sx={{ flex: 1, "& .MuiLinearProgress-bar": { bgcolor: "success.main" } }} />
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {r.bufCached}/{r.bufTotal}
        </Typography>
      </Box>
    );
  }
  if (r.bufCached) return <Typography variant="caption" color="text.secondary">{r.bufCached} 段</Typography>;
  return <Chip size="small" label="—" />;
}

export default function LectureGrid({
  rows,
  selected,
  onToggle,
  onToggleAll,
  onRowThumb,
  onRowBuf,
  density,
}: {
  rows: GridRow[];
  selected: Set<number>;
  onToggle: (id: number, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onRowThumb: (r: VideoRow) => void;
  onRowBuf: (r: VideoRow) => void;
  density: "comfortable" | "compact";
}) {
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOn = rows.some((r) => selected.has(r.id));

  const columns: GridColDef<GridRow>[] = [
    {
      field: "_sel",
      headerName: "",
      width: 50,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      renderHeader: () => (
        <Checkbox
          size="small"
          checked={allOn}
          indeterminate={!allOn && someOn}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
      ),
      renderCell: (p) => (
        <Checkbox
          size="small"
          checked={selected.has(p.row.id)}
          onChange={(e) => onToggle(p.row.id, e.target.checked)}
        />
      ),
    },
    { field: "courseName", headerName: "课程", flex: 1.1, minWidth: 120 },
    { field: "title", headerName: "讲次", flex: 1.6, minWidth: 160 },
    {
      field: "kind",
      headerName: "类型",
      width: 92,
      renderCell: (p) =>
        p.row.kind === "live" ? (
          <Chip size="small" variant="outlined" icon={<ReplayRoundedIcon />} label="回放" />
        ) : (
          <Chip size="small" variant="outlined" icon={<OndemandVideoRoundedIcon />} label="点播" />
        ),
    },
    {
      field: "duration",
      headerName: "时长",
      width: 90,
      headerAlign: "right",
      align: "right",
      valueGetter: (_v, r) => r.duration ?? 0,
      renderCell: (p) => (
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {fmtDur(p.row.duration) || "—"}
        </Typography>
      ),
    },
    {
      field: "bytes",
      headerName: "占用",
      width: 96,
      headerAlign: "right",
      align: "right",
      valueGetter: (_v, r) => r.bytes ?? 0,
      renderCell: (p) => (
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {p.row.bytes ? fmtBytes(p.row.bytes) : "—"}
        </Typography>
      ),
    },
    {
      field: "thumbState",
      headerName: "缩略图",
      width: 130,
      sortComparator: (a, b) => thumbRank[a as keyof typeof thumbRank] - thumbRank[b as keyof typeof thumbRank],
      renderCell: (p) => <ThumbChip s={p.row.thumbState} />,
    },
    {
      field: "buffer",
      headerName: "缓冲",
      flex: 1,
      minWidth: 160,
      valueGetter: (_v, r) => (r.bufTotal ? r.bufCached / r.bufTotal : r.bufCached ? 0.001 : 0),
      renderCell: (p) => <BufferCell r={p.row} />,
    },
    {
      field: "_act",
      headerName: "操作",
      width: 160,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      renderCell: (p) => (
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <Button size="small" variant="outlined" onClick={() => onRowThumb(p.row.vrow)}>
            缩略图
          </Button>
          <Button size="small" variant="outlined" onClick={() => onRowBuf(p.row.vrow)}>
            缓冲
          </Button>
        </Box>
      ),
    },
  ];

  return (
    <DataGrid
      rows={rows}
      columns={columns}
      density={density}
      disableRowSelectionOnClick
      hideFooterSelectedRowCount
      pageSizeOptions={[50, 100, 200]}
      initialState={{ pagination: { paginationModel: { pageSize: 100 } } }}
      sx={{
        border: "none",
        // Header: use MD3 surface token for subtle elevation cue
        "& .MuiDataGrid-columnHeaders": { bgcolor: "md3.surfaceContainerHighest" },
        // Cells: vertically centered, no overflow bleed
        "& .MuiDataGrid-cell": { display: "flex", alignItems: "center" },
        // Prevent horizontal scroll leak on narrow containers
        overflow: "hidden",
      }}
    />
  );
}
