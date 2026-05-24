"use client";
import * as React from "react";
import {
  Box,
  Button,
  Card,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import { usePrefs } from "@/hooks/persist";
import { useToast } from "@/components/common/Toast";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  SYSTEM_PROMPT_MAX,
} from "@/lib/chatPrefs";

// 设置页里的「AI 助教」卡片：自定义系统提示词 + 默认思考等级。
export default function AssistantCard() {
  const { prefs, setPrefs } = usePrefs();
  const toast = useToast();

  const effort = prefs.chatEffort ?? DEFAULT_EFFORT;
  const [val, setVal] = React.useState<string>(DEFAULT_SYSTEM_PROMPT);
  const [dirty, setDirty] = React.useState(false);

  // 未编辑时，跟随服务端拉回的值（首次加载 / 跨设备改动）。
  React.useEffect(() => {
    if (!dirty) setVal(prefs.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  }, [prefs.systemPrompt, dirty]);

  const tooLong = val.length > SYSTEM_PROMPT_MAX;
  const isDefault = val.trim() === DEFAULT_SYSTEM_PROMPT.trim();

  const save = async () => {
    if (tooLong) return;
    try {
      // 与默认一致就存空串 = 用内置默认（且能跟随未来默认更新）。
      await setPrefs({ systemPrompt: isDefault ? "" : val });
      setDirty(false);
      toast("已保存。已开对话的上下文将在下一条消息重新开始。", { severity: "success" });
    } catch (e) {
      toast("保存失败：" + (e as Error).message, { severity: "error" });
    }
  };

  const reset = () => {
    setVal(DEFAULT_SYSTEM_PROMPT);
    setDirty(true);
  };

  return (
    <Card sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 0.5 }}>
        <AutoAwesomeRoundedIcon color="primary" fontSize="small" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          AI 助教
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        自定义助教的系统提示词与默认思考等级。课程/讲标题等上下文会自动追加，无需手写。
      </Typography>

      {/* 默认思考等级（与对话面板里的选择同步） */}
      <Typography variant="caption" color="text.secondary">
        默认思考等级
      </Typography>
      <Box sx={{ mb: 2, mt: 0.5 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={effort}
          onChange={(_e, v) => v && void setPrefs({ chatEffort: v })}
          sx={{
            flexWrap: "wrap",
            "& .MuiToggleButton-root": { textTransform: "none", px: 1.5 },
          }}
        >
          {EFFORT_LEVELS.map((l) => (
            <ToggleButton key={l.value} value={l.value}>
              <Tooltip title={l.hint}>
                <span>{l.label}</span>
              </Tooltip>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {/* 系统提示词 */}
      <TextField
        label="系统提示词"
        value={val}
        onChange={(e) => {
          setVal(e.target.value);
          setDirty(true);
        }}
        multiline
        minRows={6}
        maxRows={18}
        fullWidth
        error={tooLong}
        helperText={
          tooLong
            ? `过长：${val.length} / ${SYSTEM_PROMPT_MAX} 字符`
            : `${val.length} / ${SYSTEM_PROMPT_MAX} 字符${isDefault ? "（与默认一致）" : ""}`
        }
        sx={{ "& textarea": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.85rem", lineHeight: 1.6 } }}
      />

      <Stack direction="row" spacing={1} sx={{ mt: 1.5, justifyContent: "flex-end" }}>
        <Button variant="text" onClick={reset} disabled={isDefault && !dirty}>
          恢复默认
        </Button>
        <Button variant="contained" onClick={save} disabled={tooLong || !dirty}>
          保存
        </Button>
      </Stack>
    </Card>
  );
}
