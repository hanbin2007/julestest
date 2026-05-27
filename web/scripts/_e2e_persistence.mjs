// e2e: 网关全持久化验收 (跨 kill -9 重启)
//   1. 已持久化文件齐全: index.json/seg_urls.json/video_metadata.json/buf_state.json(可选)/
//      buf_jobs.json(可选)/pf_done.json/playhead.json(用户播放后)/thumb_index.json/thumb_jobs.json(可选)
//   2. 重启后 video_headers 自动从 video_meta 重建(无需 web 触发 /api/play)
//   3. perVid 18 项立刻有 total (seg_urls.json 回载生效)
//   4. allTasks 跨重启保留 (TaskHistory DB)
import { promises as fs } from "node:fs";
const CACHE_DIR = "/Volumes/Samsung - Data/youdao-course-cache";
const THUMB_DIR = "/Users/zhb/.youdao_course/thumbs";
const HOST = "http://127.0.0.1:3000";
const GW = "http://127.0.0.1:8808";

async function fileExistsOk(path) {
  try { const s = await fs.stat(path); return s.size >= 0; } catch { return false; }
}

async function p0_persistFiles() {
  const files = {
    "index.json (seg_cache)": `${CACHE_DIR}/index.json`,
    "seg_urls.json": `${CACHE_DIR}/seg_urls.json`,
    "video_metadata.json": `${CACHE_DIR}/video_metadata.json`,
    "thumb_index.json": `${THUMB_DIR}/index.json`,
  };
  // 这些是必须存在的;其它(buf_state/buf_jobs/pf_done/playhead/thumb_jobs)依赖用户是否做过操作。
  const checks = {};
  for (const [name, p] of Object.entries(files)) checks[name] = await fileExistsOk(p);
  const allOk = Object.values(checks).every(Boolean);
  return { ok: allOk, checks };
}

async function p1_thumbAllStates() {
  // thumb_index.json 现在该含全部状态(我用 sample 检验逻辑能力)
  const content = await fs.readFile(`${THUMB_DIR}/index.json`, "utf-8").catch(() => "{}");
  const idx = JSON.parse(content);
  const states = Object.values(idx).map((v) => v?.state).filter(Boolean);
  const stateSet = [...new Set(states)];
  return { ok: states.length > 0, count: states.length, states: stateSet };
}

async function p1_videoMetaRebuilds() {
  // 启动重建: 网关启动后立即 perVid 应有 total (seg_urls.json + video_meta 都齐).
  // 通过 /api/status 直接看 buffer.perVid 项是否每个都有 total != null。
  const status = await fetch(`${GW}/api/status`).then((r) => r.json());
  const perVid = status?.buffer?.perVid || {};
  const items = Object.entries(perVid);
  const withTotal = items.filter(([, v]) => v.total).length;
  const cachedGt0 = items.filter(([, v]) => (v.cached || 0) > 0).length;
  return { ok: items.length > 0 && withTotal === items.length, items: items.length, withTotal, cachedGt0 };
}

async function p1_allTasksHistorySurvives() {
  const data = await fetch(`${HOST}/api/courses/status`).then((r) => r.json());
  const al = data.allTasks || [];
  const byKind = al.reduce((a, t) => ((a[t.kind] = (a[t.kind] || 0) + 1), a), {});
  return { ok: al.length > 0, count: al.length, byKind };
}

const r1 = await p0_persistFiles();
console.log("P0 文件齐全:", JSON.stringify(r1, null, 2));
const r2 = await p1_thumbAllStates();
console.log("P1 thumb 全态:", JSON.stringify(r2, null, 2));
const r3 = await p1_videoMetaRebuilds();
console.log("P1 启动重建(seg_urls+video_meta):", JSON.stringify(r3, null, 2));
const r4 = await p1_allTasksHistorySurvives();
console.log("P1 任务历史跨重启:", JSON.stringify(r4, null, 2));

const ok = r1.ok && r2.ok && r3.ok && r4.ok;
process.exit(ok ? 0 : 1);
