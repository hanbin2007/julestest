"use client";
import { Box } from "@mui/material";
import AppTopBar from "@/components/common/AppTopBar";
import NotesView from "@/components/notes/NotesView";

export default function NotesPage() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <AppTopBar context="笔记" />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <NotesView />
      </Box>
    </Box>
  );
}
