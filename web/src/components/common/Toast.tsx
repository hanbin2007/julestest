"use client";
import * as React from "react";
import Snackbar from "@mui/material/Snackbar";
import Alert, { type AlertColor } from "@mui/material/Alert";
import Button from "@mui/material/Button";

interface ToastOpts {
  severity?: AlertColor;
  action?: { label: string; onClick: () => void };
}
type ToastFn = (msg: string, opts?: ToastOpts) => void;

const Ctx = React.createContext<ToastFn>(() => {});
export const useToast = () => React.useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{
    open: boolean;
    msg: string;
    severity: AlertColor;
    action?: ToastOpts["action"];
  }>({ open: false, msg: "", severity: "info" });

  const toast = React.useCallback<ToastFn>((msg, opts) => {
    setState({ open: true, msg, severity: opts?.severity ?? "info", action: opts?.action });
  }, []);
  const close = () => setState((s) => ({ ...s, open: false }));

  return (
    <Ctx.Provider value={toast}>
      {children}
      <Snackbar
        open={state.open}
        autoHideDuration={3200}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          variant="filled"
          severity={state.severity}
          onClose={close}
          sx={{ borderRadius: (t) => t.radius.md, alignItems: "center" }}
          action={
            state.action ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  state.action?.onClick();
                  close();
                }}
              >
                {state.action.label}
              </Button>
            ) : undefined
          }
        >
          {state.msg}
        </Alert>
      </Snackbar>
    </Ctx.Provider>
  );
}
