"use client";
import * as React from "react";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { Box, Checkbox, Chip, IconButton, Tooltip, Typography } from "@mui/material";
import OndemandVideoRoundedIcon from "@mui/icons-material/OndemandVideoRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import CacheBar from "@/components/common/CacheBar";
import { fmtDur, fmtBytes } from "@/lib/media";
import type { SegmentMap, VideoRow } from "@/types/api";

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
  segMap?: SegmentMap; // 详情抽屉里附逐片 bitmap；平铺视图无此字段 → 缓存条回退到比例填充
  vrow: VideoRow;
}

const thumbRank = { ready: 3, gen: 2, error: 1, none: 0 } as const;

function ThumbChip({ s }: { s: GridRow["thumbState"] }) {
  if (s === "ready") return <Chip size="small" color="success" label="✓ 已生成" />;
  if (s === "gen") return <Chip size="small" color="primary" label="⏳ 生成中" />;
  if (s === "error") return <Chip size="small" color="error" label="✗ 失败" />;
  return <Chip size="small" label="— 未生成" />;
}

// 缓存列：统一用缓存条。有 bitmap 显示"已缓存的地方"分布；否则比例填充；缓冲中扫光、失败红条。
function BufferCell({ r }: { r: GridRow }) {
  return (
    <Box sx={{ width: "100%" }}>
      <CacheBar
        map={r.segMap}
        cached={r.bufCached}
        total={r.bufTotal}
        state={r.bufState}
        height={10}
        showLabel
      />
    </Box>
  );
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
      width: 96,
      align: "center",
      headerAlign: "center",
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      renderCell: (p) => (
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <Tooltip title="生成缩略图">
            <IconButton size="small" onClick={() => onRowThumb(p.row.vrow)} aria-label="生成缩略图">
              <ImageRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="缓冲整集">
            <IconButton size="small" onClick={() => onRowBuf(p.row.vrow)} aria-label="缓冲整集">
              <DownloadRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
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
