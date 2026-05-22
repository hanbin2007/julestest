"use client";
import { Box } from "@mui/material";
import AppTopBar from "@/components/common/AppTopBar";
import SettingsView from "@/components/settings/SettingsView";

export default function SettingsPage() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <AppTopBar />
      <Box sx={{ flex: 1, overflowY: "auto" }}>
        <SettingsView />
      </Box>
    </Box>
  );
}
