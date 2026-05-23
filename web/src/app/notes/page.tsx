"use client";
import { Box } from "@mui/material";
import AppTopBar from "@/components/common/AppTopBar";
import NotesView from "@/components/notes/NotesView";

export default function NotesPage() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <AppTopBar />
      <Box sx={{ flex: 1, overflowY: "auto" }}>
        <NotesView />
      </Box>
    </Box>
  );
}
