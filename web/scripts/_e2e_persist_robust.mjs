// e2e: 持久化健壮性 (kill -9 网关 → 重启 → 断言状态保留)。
// 失败信号(区分"修复生效"vs"修复缺失"):
//   #1 buffer error reason 跨重启保留   (修复前: 重启后 reason=null)
//   #2 _extra_protect 跨重启回载        (修复前: 重启后 extraProtect=[])
//   #3 无 queued-无-job 僵尸             (修复前: 重启后存在 queued 但无 reason 的死任务)
//   #4 原子性: 无残留 *.json.tmp + thumb/seg_urls JSON 可正常 parse
//   #5 pf_threads 有界
//   #6 recover-flush 循环不破坏持久化态(周期性 tick 幂等)
// 可重复运行: 用一个固定测试 vid, 每次跑前先清掉它的状态文件痕迹(幂等)。
// 手动掉盘验证(无法无头自动化): 缓冲运行时拔掉外置盘, 观察 /api/status cacheDirOk:false,
// 重新挂载, 等 6s, 确认 /api/_debug extraProtect + 盘上 seg_urls.json 反映掉盘后的最新状态。
import { promises as fs } from "node:fs";
import { execSync, spawn } from "node:child_process";

const ROOT = "/Users/zhb/Documents/julestest";
const CACHE_DIR = "/Volumes/Samsung - Data/youdao-course-cache";
const THUMB_DIR = "/Users/zhb/.youdao_course/thumbs";
const GW = "http://127.0.0.1:8808";
const HOST = "http://127.0.0.1:3000";
// 合成测试 vid: 不依赖真实课程, 直接写进持久化文件再重启验证回载。
const TEST_VID = "999000111";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const d = await fetch(`${GW}/api/_debug`).then((r) => r.json());
      const w = await fetch(`${HOST}/`).then((r) => r.status);
      if (d && w === 200) return true;
    } catch { /* not up yet */ }
    await sleep(1500);
  }
  throw new Error("stack 未就绪");
}

function stopStack() {
  try {
    const pid = execSync("pgrep -f 'bash ./run.sh' | head -n1").toString().trim();
    if (pid) execSync(`kill -TERM ${pid}`);
  } catch { /* maybe not running */ }
  // 关键: 直接 kill -9 网关进程(Python 改动必须硬杀), 模拟硬崩溃。
  try { execSync("pkill -9 -f 'youdao_course.py serve'"); } catch { /* none */ }
  // 等端口释放, 残留监听强杀。
  for (let i = 0; i < 20; i++) {
    const left = (() => { try { return execSync("lsof -nP -iTCP:3000,8808 -sTCP:LISTEN -t 2>/dev/null").toString().trim(); } catch { return ""; } })();
    if (!left) return;
    try { execSync(`kill -9 ${left.split(/\s+/).join(" ")}`); } catch { /* */ }
    execSync("sleep 1");
  }
}

function startStack() {
  const child = spawn("perl", ["-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", "./run.sh"], {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf-8")); } catch { return fallback; }
}
async function writeJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj), "utf-8");
}

// --- 准备阶段: 把一个"已 error 且有 reason"的合成任务 + 一个"queued 无 job 僵尸"写进持久化文件 ---
async function seedState() {
  // buf_state.json: TEST_VID=error, 僵尸 vid=queued(故意不给 buf_jobs)
  const bufState = await readJson(`${CACHE_DIR}/buf_state.json`, {});
  bufState[TEST_VID] = "error";
  bufState["888000222"] = "queued"; // 僵尸: 下面不写 buf_jobs
  await writeJson(`${CACHE_DIR}/buf_state.json`, bufState);
  // buf_errors.json: TEST_VID 的失败原因
  const bufErrors = await readJson(`${CACHE_DIR}/buf_errors.json`, {});
  bufErrors[TEST_VID] = "分片下载失败 7 个: 测试原因_e2e";
  await writeJson(`${CACHE_DIR}/buf_errors.json`, bufErrors);
  // playhead.json: extra_protect 含 TEST_VID
  const ph = await readJson(`${CACHE_DIR}/playhead.json`, {});
  ph.extra_protect = Array.from(new Set([...(ph.extra_protect || []), TEST_VID]));
  await writeJson(`${CACHE_DIR}/playhead.json`, ph);
  // 确保僵尸 vid 在 buf_jobs.json 里"没有" job
  const jobs = await readJson(`${CACHE_DIR}/buf_jobs.json`, {});
  delete jobs["888000222"];
  delete jobs[TEST_VID]; // TEST_VID 也不给 job, 但它是 error 不是 queued, 不会被转
  await writeJson(`${CACHE_DIR}/buf_jobs.json`, jobs);
}

// 清掉本测试注入的合成 vid 痕迹, 让脚本可重复运行(不污染真实数据)。
async function cleanupSeed() {
  for (const f of ["buf_state.json", "buf_errors.json", "buf_jobs.json"]) {
    const obj = await readJson(`${CACHE_DIR}/${f}`, {});
    delete obj[TEST_VID]; delete obj["888000222"];
    await writeJson(`${CACHE_DIR}/${f}`, obj);
  }
  const ph = await readJson(`${CACHE_DIR}/playhead.json`, {});
  if (Array.isArray(ph.extra_protect)) {
    ph.extra_protect = ph.extra_protect.filter((v) => v !== TEST_VID && v !== "888000222");
    await writeJson(`${CACHE_DIR}/playhead.json`, ph);
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

async function main() {
  await waitReady();

  // 1) 注入合成状态 → kill -9 → 重启 → 断言回载。
  await seedState();
  stopStack();
  startStack();
  await waitReady();

  const dbg = await fetch(`${GW}/api/_debug`).then((r) => r.json());
  const status = await fetch(`${GW}/api/status`).then((r) => r.json());
  const perVid = status?.buffer?.perVid || {};

  // #1 error reason 跨重启保留 (失败信号: 修复前 reason 为 undefined/null)
  const reason = (perVid[TEST_VID] || {}).reason;
  check("#1 error reason 跨 kill-9 保留", typeof reason === "string" && reason.includes("测试原因_e2e"),
    { reason, state: (perVid[TEST_VID] || {}).state });

  // #2 _extra_protect 跨重启回载 (失败信号: 修复前 extraProtect 不含 TEST_VID)
  const ep = dbg.extraProtect || [];
  check("#2 _extra_protect 跨重启回载", ep.includes(TEST_VID), { extraProtect: ep });

  // #3 无僵尸: 888000222 不应停在 queued 无 reason; 应被转成 error
  const zState = (dbg.bufStates || {})["888000222"];
  const zReason = (dbg.bufErrors || {})["888000222"];
  check("#3 僵尸 queued 已转 error", zState === "error" && typeof zReason === "string",
    { state: zState, reason: zReason });
  // 强失败信号: 绝不允许还停在 queued
  check("#3b 无 queued 僵尸残留", zState !== "queued", { state: zState });

  // #4 原子性: 无残留 *.json.tmp; thumb index + seg_urls 可 parse
  const tmpsCache = (await fs.readdir(CACHE_DIR)).filter((f) => f.endsWith(".json.tmp"));
  const tmpsThumb = (await fs.readdir(THUMB_DIR)).filter((f) => f.endsWith(".json.tmp"));
  check("#4a 无残留 *.json.tmp", tmpsCache.length === 0 && tmpsThumb.length === 0,
    { cache: tmpsCache, thumb: tmpsThumb });
  let thumbOk = true, segOk = true;
  try { JSON.parse(await fs.readFile(`${THUMB_DIR}/index.json`, "utf-8")); } catch (e) { thumbOk = e.code === "ENOENT"; }
  try { JSON.parse(await fs.readFile(`${CACHE_DIR}/seg_urls.json`, "utf-8")); } catch (e) { segOk = e.code === "ENOENT"; }
  check("#4b thumb/seg_urls JSON 可解析", thumbOk && segOk, { thumbOk, segOk });

  // #5 pf_threads 有界 (打几次 /api/play 不应让 pfThreads 无限增长; 这里仅断言是数组且不爆炸)
  const dbg2 = await fetch(`${GW}/api/_debug`).then((r) => r.json());
  check("#5 pfThreads 有界(<=64)", Array.isArray(dbg2.pfThreads) && dbg2.pfThreads.length <= 64,
    { pfThreads: dbg2.pfThreads.length });

  // #6 recover-flush 循环不破坏状态: 等一个 flush 周期, extraProtect/bufStates 仍自洽。
  await sleep(6000);
  const dbg3 = await fetch(`${GW}/api/_debug`).then((r) => r.json());
  check("#6 recover-flush 不损坏持久化态", (dbg3.extraProtect || []).includes(TEST_VID),
    { extraProtect: dbg3.extraProtect });

  await cleanupSeed();

  const allOk = results.every((r) => r.ok);
  console.log(`\nALL PASS: ${allOk}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error("e2e error:", e); process.exit(2); });
