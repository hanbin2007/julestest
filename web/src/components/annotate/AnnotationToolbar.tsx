"use client";
import * as React from "react";
import { Box, Card, Divider, IconButton, Stack, TextField, Tooltip } from "@mui/material";
import { motion, useDragControls } from "framer-motion";
import DragIndicatorRoundedIcon from "@mui/icons-material/DragIndicatorRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import BorderColorRoundedIcon from "@mui/icons-material/BorderColorRounded";
import HorizontalRuleRoundedIcon from "@mui/icons-material/HorizontalRuleRounded";
import CropSquareRoundedIcon from "@mui/icons-material/CropSquareRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import NorthEastRoundedIcon from "@mui/icons-material/NorthEastRounded";
import BackspaceOutlinedIcon from "@mui/icons-material/BackspaceOutlined";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";
import RedoRoundedIcon from "@mui/icons-material/RedoRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import NoteAddRoundedIcon from "@mui/icons-material/NoteAddRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import HighlightAltRoundedIcon from "@mui/icons-material/HighlightAltRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import ContentPasteRoundedIcon from "@mui/icons-material/ContentPasteRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { WIDTHS, type ActiveTool } from "./model";
import type { AnnotationApi } from "./useAnnotation";

const TOOLS: { tool: ActiveTool; label: string; Icon: React.ElementType }[] = [
  { tool: "pen", label: "画笔", Icon: EditRoundedIcon },
  { tool: "marker", label: "荧光笔", Icon: BorderColorRoundedIcon },
  { tool: "line", label: "直线", Icon: HorizontalRuleRoundedIcon },
  { tool: "arrow", label: "箭头", Icon: NorthEastRoundedIcon },
  { tool: "rect", label: "矩形", Icon: CropSquareRoundedIcon },
  { tool: "ellipse", label: "圆/椭圆", Icon: RadioButtonUncheckedRoundedIcon },
  { tool: "lasso", label: "套索（选中后可移动/旋转/缩放）", Icon: HighlightAltRoundedIcon },
  { tool: "eraser", label: "橡皮", Icon: BackspaceOutlinedIcon },
];

export default function AnnotationToolbar({
  api,
  bounds,
  text,
  setText,
  onSaveNote,
  onAskClaude,
  onClose,
  busy,
}: {
  api: AnnotationApi;
  bounds: HTMLElement | null;
  text: string;
  setText: (s: string) => void;
  onSaveNote: () => void;
  onAskClaude: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const dragControls = useDragControls();
  const hasInk = api.objects.length > 0;

  return (
    <motion.div
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={bounds ? { current: bounds } : undefined}
      style={{ position: "absolute", top: 12, left: 12, zIndex: 40 }}
    >
      <Card
        sx={{
          p: 0.75,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          bgcolor: "md3.surfaceContainerHigh",
          borderRadius: (t) => t.radius.lg,
          boxShadow: 8,
          flexWrap: "wrap",
          maxWidth: 560,
        }}
      >
        {/* 拖拽手柄 */}
        <Box
          onPointerDown={(e) => dragControls.start(e)}
          sx={{ display: "flex", alignItems: "center", cursor: "grab", color: "text.secondary", px: 0.25 }}
        >
          <DragIndicatorRoundedIcon fontSize="small" />
        </Box>

        {/* 工具 */}
        <Stack direction="row" spacing={0.25}>
          {TOOLS.map(({ tool, label, Icon }) => {
            const active = api.tool === tool;
            return (
              <Tooltip key={tool} title={label}>
                <IconButton
                  size="small"
                  onClick={() => api.setTool(tool)}
                  sx={{
                    color: active ? "primary.contrastText" : "text.primary",
                    bgcolor: active ? "primary.main" : "transparent",
                    "&:hover": { bgcolor: active ? "primary.main" : "action.hover" },
                  }}
                >
                  <Icon fontSize="small" />
                </IconButton>
              </Tooltip>
            );
          })}
        </Stack>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />

        {/* 颜色 */}
        <Stack direction="row" spacing={0.5} sx={{ px: 0.25 }}>
          {api.colors.map((c) => (
            <Box
              key={c}
              onClick={() => api.setColor(c)}
              sx={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                bgcolor: c,
                cursor: "pointer",
                border: (t) =>
                  api.color === c ? `2px solid ${t.palette.primary.main}` : `1px solid ${t.palette.divider}`,
                boxSizing: "border-box",
              }}
            />
          ))}
        </Stack>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />

        {/* 线宽 */}
        <Stack direction="row" spacing={0.25} sx={{ alignItems: "center", px: 0.25 }}>
          {WIDTHS.map((wd, i) => (
            <Box
              key={wd}
              onClick={() => api.setWidth(wd)}
              sx={{
                width: 22,
                height: 22,
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                borderRadius: (t) => t.radius.sm,
                bgcolor: api.width === wd ? "action.selected" : "transparent",
              }}
            >
              <Box sx={{ width: 14, height: 2 + i * 2.5, borderRadius: 4, bgcolor: "text.primary" }} />
            </Box>
          ))}
        </Stack>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />

        {/* 历史 */}
        <Tooltip title="撤销">
          <span>
            <IconButton size="small" disabled={!api.canUndo} onClick={api.undo}>
              <UndoRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="重做">
          <span>
            <IconButton size="small" disabled={!api.canRedo} onClick={api.redo}>
              <RedoRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="清空">
          <span>
            <IconButton size="small" disabled={!hasInk} onClick={api.clear}>
              <DeleteSweepRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />

        {/* 选区操作（套索选中后可用）*/}
        <Tooltip title="复制选中 (⌘C)">
          <span>
            <IconButton size="small" disabled={!api.canCopy} onClick={api.copy}>
              <ContentCopyRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="粘贴 (⌘V)">
          <span>
            <IconButton size="small" disabled={!api.canPaste} onClick={api.paste}>
              <ContentPasteRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="删除选中 (Del)">
          <span>
            <IconButton size="small" disabled={!api.canCopy} onClick={api.deleteSelected}>
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        {/* 文字说明 */}
        <TextField
          size="small"
          placeholder="一行说明（可选）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          sx={{ width: 150, "& .MuiInputBase-input": { fontSize: 13, py: 0.5 } }}
        />

        <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />

        {/* 动作 */}
        <Tooltip title="存入笔记">
          <span>
            <IconButton
              size="small"
              color="primary"
              aria-label="存入笔记"
              disabled={busy || (!hasInk && !text.trim())}
              onClick={onSaveNote}
            >
              <NoteAddRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="问 Claude">
          <span>
            <IconButton size="small" color="primary" aria-label="问 Claude" disabled={busy} onClick={onAskClaude}>
              <AutoAwesomeRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="关闭批注">
          <IconButton size="small" onClick={onClose}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Card>
    </motion.div>
  );
}
