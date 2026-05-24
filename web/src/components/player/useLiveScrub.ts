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
      v.removeEventListener("seeked", done); // 赋值抛出时移除泄漏的监听器
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

  // 长按快进期间屏蔽「滑动视频画面改进度」：ArtPlayer 的 fastForward(长按) 与 gesture(滑动 seek)
  // 都绑在 $video 触摸上，长按触发后手指稍一横移就被 gesture 当成拖动进度而误跳。
  // 仅在 fast-forward 激活时（$player 带 art-fast-forward 类）于捕获阶段拦掉 $video 的 touchmove
  // （捕获在目标元素先于冒泡执行，故早于 gesture 的冒泡 onTouchMove），stopImmediatePropagation
  // 让其 seek 不执行。未长按时此守卫不做任何事 —— 普通滑动 seek 一切照旧。
  const vEl = art?.template?.$video as HTMLElement | undefined;
  const blockSeekWhileFF = (e: Event) => {
    if (root.classList.contains("art-fast-forward")) e.stopImmediatePropagation();
  };
  vEl?.addEventListener("touchmove", blockSeekWhileFF, { capture: true });

  prog.addEventListener("pointerdown", onDown as EventListener);
  window.addEventListener("pointermove", onMove as EventListener);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp); // 触摸被系统手势打断时也要结束拖拽
  return () => {
    vEl?.removeEventListener("touchmove", blockSeekWhileFF, { capture: true });
    prog.removeEventListener("pointerdown", onDown as EventListener);
    window.removeEventListener("pointermove", onMove as EventListener);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
}
