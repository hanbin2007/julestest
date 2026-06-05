"use client";
import * as React from "react";
import { Alert, Box, Button, Card, Stack, TextField, Typography } from "@mui/material";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import { useToast } from "@/components/common/Toast";

// 缓存目录设置卡：查看 / 修改持久化缓存目录。
//  · 当前生效目录(active)来自网关 /api/status；丢失/掉盘时高亮报错且缓存停用。
//  · 保存只校验并写入网关 config.json，下次启动网关生效（当前会话仍写旧目录）——
//    刻意不热替换正在写入的缓存，避开在途下载/线程的竞态。
const Mono = ({ children }: { children: React.ReactNode }) => (
  <Box component="code" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
    {children}
  </Box>
);

function CacheDirCard({
  cacheDir,
  cacheDirOk,
  onSaved,
}: {
  cacheDir: string;
  cacheDirOk: boolean;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [dir, setDir] = React.useState(cacheDir);
  const [saving, setSaving] = React.useState(false);
  const [pending, setPending] = React.useState<{
    configured: string;
    active: string;
    restartRequired: boolean;
  } | null>(null);

  // 初次拿到生效目录时把它灌进输入框；之后交给用户，不被轮询覆盖。
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!seeded.current && cacheDir) {
      setDir(cacheDir);
      seeded.current = true;
    }
  }, [cacheDir]);

  const missing = !!cacheDir && !cacheDirOk;

  const save = async () => {
    const value = dir.trim();
    if (!value) return;
    setSaving(true);
    try {
      const r = await fetch("/api/cache-dir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) {
        toast("保存失败：" + (j?.error || r.statusText), { severity: "error" });
        return;
      }
      setPending({
        configured: j.cacheDir,
        active: j.active ?? "",
        restartRequired: !!j.restartRequired,
      });
      toast(j.restartRequired ? "已保存，重启网关后生效" : "已保存", { severity: "success" });
      onSaved?.();
    } catch (e) {
      toast("保存失败：" + (e as Error).message, { severity: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card sx={{ p: 2, mb: 2 }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <FolderRoundedIcon fontSize="small" color="action" />
          <Typography variant="subtitle1">缓存目录</Typography>
        </Box>

        {missing ? (
          <Alert severity="error">
            当前缓存目录不可用：<Mono>{cacheDir}</Mono>
            <br />
            缓存已停用，且不会自动重建（可能是外置盘未挂载或目录被删）。请填写一个可用目录并保存，
            或恢复该目录后重启网关。
          </Alert>
        ) : null}

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "flex-start" }}>
          <TextField
            size="small"
            label="缓存目录（绝对路径）"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="例如 /Volumes/External/youdao-cache"
            fullWidth
            error={missing}
            helperText={
              cacheDir
                ? `当前生效：${cacheDir}${cacheDirOk ? "" : "（不可用）"}`
                : "当前为临时目录（重启即清）"
            }
          />
          <Button
            variant="contained"
            onClick={save}
            disabled={saving || !dir.trim()}
            sx={{ flexShrink: 0, mt: { sm: 0.5 } }}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </Stack>

        {pending?.restartRequired ? (
          <Alert severity="info">
            已保存到配置：<Mono>{pending.configured}</Mono>。下次启动网关后生效；当前会话仍写入旧目录{" "}
            <Mono>{pending.active || "（临时）"}</Mono>。
          </Alert>
        ) : null}
      </Stack>
    </Card>
  );
}

export default React.memo(CacheDirCard);
