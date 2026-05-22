/* eslint-disable @typescript-eslint/no-explicit-any */
// 拖动进度条时大画面实时跟手：拖动中暂停、追帧(单次 in-flight, 合并最新)、松手续播。
export function attachLiveScrub(art: any): () => void {
  const root = art?.template?.$player as HTMLElement | undefined;
  if (!root) return () => {};
  const prog =
    (root.querySelector(".art-control-progress-inner") as HTMLElement | null) ??
    (root.querySelector(".art-control-progress") as HTMLElement | null);
  if (!prog) return () => {};
  const v: HTMLVideoElement = art.video;
  let on = false;
  let want: number | null = null;
  let busy = false;
  let wasPlaying = false;

  const timeAt = (e: PointerEvent) => {
    const r = prog.getBoundingClientRect();
    const n = Math.min(Math.max(e.clientX - r.left, 0), prog.clientWidth);
    return (n / prog.clientWidth) * (v.duration || 0);
  };
  const chase = (t: number) => {
    want = t;
    if (busy) return;
    busy = true;
    const done = () => {
      v.removeEventListener("seeked", done);
      busy = false;
      if (want != null && Math.abs(want - t) > 0.05) {
        const n = want;
        want = null;
        chase(n);
      } else want = null;
    };
    v.addEventListener("seeked", done);
    try {
      v.currentTime = t;
    } catch {
      busy = false;
    }
  };
  const onMove = (e: PointerEvent) => {
    if (on) chase(timeAt(e));
  };
  const onUp = () => {
    if (!on) return;
    on = false;
    if (wasPlaying) v.play().catch(() => {});
  };
  const onDown = (e: PointerEvent) => {
    on = true;
    wasPlaying = !v.paused;
    if (wasPlaying) v.pause();
    chase(timeAt(e));
  };

  prog.addEventListener("pointerdown", onDown as EventListener);
  window.addEventListener("pointermove", onMove as EventListener);
  window.addEventListener("pointerup", onUp);
  return () => {
    prog.removeEventListener("pointerdown", onDown as EventListener);
    window.removeEventListener("pointermove", onMove as EventListener);
    window.removeEventListener("pointerup", onUp);
  };
}
