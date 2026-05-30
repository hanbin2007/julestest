// e2e (隔离): 掉盘恢复守卫 (#2) 端到端验证 —— Plan Task 1。
//
// 复现真实 bug: 外置盘没挂就启动网关 -> seg_cache.ok=False, 内存全空(未载入任何 *.json)。
// 用户挂回盘(不重启) -> _recover_flush_loop 看到 ok False->True。
//   旧 bug : 直接把【空内存】flush 回盘, 把盘上真实持久化态(buf_state.json 等)清零("救盘擦了盘")。
//   治本   : _ever_loaded 标志区分"运行中掉盘(刷回内存)"vs"启动即掉盘从未载入(重载磁盘)";
//            从未载入时盘才是真相, 盘回来后 _reload_all_persist 重载, 而非覆盖。
//
// 失败信号(区分"修复生效"vs"修复没生效"):
//   断言: 盘回来后 buf_state.json 仍是 {"123":"done"} 且 /api/_debug.bufStates 反映它。
//   若把 _recover_once 的守卫去掉(退回旧 always-flush 行为), 盘上文件被空内存覆盖成 {} -> FAIL。
//
// 硬约束 [[julestest-no-prod-db-writes]]: 绝不碰生产 app.db / 生产缓存 / 生产网关 8808 / web 3000 /
//   生产 thumbs。全部状态进全新 mkdtemp TMPDIR; 隔离网关端口 8810(非 8808/8809); YD_THUMB_DIR
//   重定向到 TMPDIR。web 侧不起 next(本测试只需网关 + 文件断言)。
//
// 模拟"盘没挂": 把 --cache-dir 指到 TMPDIR/mnt/cache, 而 TMPDIR/mnt 启动时是个【文件】(非目录),
//   resolve_cache_dir 的 os.makedirs 失败 -> (cache_dir, ok=False), 网关照常起但缓存停用、不载入。
//   随后"挂盘": 删掉那个文件, 在同一路径建好目录 + 预置 buf_state.json={"123":"done"}, 使其可写。
//   _recover_flush_loop 每 5s dir_ok() 探测到目录回来 -> ok 翻 True -> _recover_once 重载。
//
// 可重复: 每次全新 mkdtemp; teardown 杀隔离进程 + rm -rf TMPDIR。连跑两遍都过。

import { promises as fs } from "node:fs";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");      // .../worktree/web
const ROOT = path.resolve(WEB_DIR, "..");                          // .../worktree
const PROD_REQ = "/Users/zhb/Documents/julestest/req.txt";        // 只读复用生产抓包(不修改)
const PORT = 8810;                                                // 非生产端口(8808 生产 / 8809 另一隔离脚本)
const GW = `http://127.0.0.1:${PORT}`;

const PROD_DB = "/Users/zhb/.youdao_course/app.db";
const PROD_CACHE = "/Users/zhb/.youdao_course/cache";
const PROD_THUMBS = "/Users/zhb/.youdao_course/thumbs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
}

let gwChild = null;
let TMPDIR = "";
let MNT = "";        // TMPDIR/mnt —— 启动时是文件(模拟盘没挂), 后改成目录(挂盘)
let CACHE_DIR = "";  // TMPDIR/mnt/cache —— 网关 --cache-dir
let THUMB_DIR = "";
let SEEDED = "";     // 预置好的真实缓存内容(挂盘时搬到 CACHE_DIR)

function assertIsolatedPaths() {
  for (const p of [TMPDIR, CACHE_DIR, THUMB_DIR]) {
    if (!p.startsWith(TMPDIR)) throw new Error(`隔离路径越界(非 TMPDIR 子路径): ${p}`);
  }
  for (const prod of [PROD_DB, PROD_CACHE, PROD_THUMBS]) {
    if (CACHE_DIR === prod || THUMB_DIR === prod) throw new Error(`隔离路径撞生产: ${prod}`);
  }
  if (PORT === 8808) throw new Error("端口撞生产 8808");
}

function startGateway() {
  gwChild = spawn(
    "python3",
    ["youdao_course.py", "serve", "-r", PROD_REQ, "--port", String(PORT),
      "--cache-dir", CACHE_DIR, "--no-prefetch", "--log-level", "WARNING"],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, YD_THUMB_DIR: THUMB_DIR },
    },
  );
  gwChild.unref();
}

async function waitGatewayUp(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${GW}/api/_debug`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("隔离网关未就绪(8810)");
}

function gatewayPid() {
  try {
    return execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null`).toString().trim();
  } catch { return ""; }
}

function killGatewayHard() {
  const pid = gatewayPid();
  if (pid) {
    for (const p of pid.split(/\s+/)) {
      try { execSync(`kill -9 ${p}`); } catch { /* already gone */ }
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!gatewayPid()) return;
    try { execSync("sleep 0.3"); } catch { /* */ }
  }
}

async function gwDebug() {
  const r = await fetch(`${GW}/api/_debug`);
  return r.json();
}

async function readBufState() {
  try { return JSON.parse(await fs.readFile(path.join(CACHE_DIR, "buf_state.json"), "utf-8")); }
  catch (e) { return { __read_error: e.code || String(e) }; }
}

// ================= 测试主体 =================
async function run() {
  // 1) 预置真实缓存内容(模拟"上个进程写好的盘"): buf_state.json + playhead.extra_protect。
  await fs.mkdir(SEEDED, { recursive: true });
  await fs.writeFile(path.join(SEEDED, "buf_state.json"), JSON.stringify({ "123": "done" }), "utf-8");
  await fs.writeFile(path.join(SEEDED, "playhead.json"),
    JSON.stringify({ playhead: {}, protect_vid: null, extra_protect: ["321"] }), "utf-8");

  // 2) "盘没挂": TMPDIR/mnt 是个文件 -> os.makedirs(CACHE_DIR) 失败 -> 网关起但 cache ok=False/不载入。
  await fs.writeFile(MNT, "blocker (simulates unmounted drive)", "utf-8");

  startGateway();
  await waitGatewayUp();

  // 启动即掉盘: bufStates 应为空(没载入任何盘上态)。这是恢复前的基线。
  const dbgBoot = await gwDebug();
  check(
    "[守卫] 启动时盘没挂: bufStates 为空(未载入)",
    Object.keys(dbgBoot.bufStates || {}).length === 0,
    { bufStates: dbgBoot.bufStates },
  );

  // 3) "挂盘": 删掉占位文件, 在同一路径建目录 + 把预置内容搬进去, 使其可写。
  await fs.rm(MNT, { force: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  for (const f of await fs.readdir(SEEDED)) {
    await fs.rename(path.join(SEEDED, f), path.join(CACHE_DIR, f));
  }

  // 4) 等过 _recover_flush_loop 的 5s 探测周期(留足余量): ok 翻 True -> _recover_once 重载磁盘。
  await sleep(9000);

  // 5) 断言: 盘上 buf_state.json 没被空内存覆盖(仍是 {"123":"done"}), 且被载入内存。
  const onDisk = await readBufState();
  check(
    "[守卫] 盘回来后 buf_state.json 未被空内存覆盖(仍 {'123':'done'})",
    onDisk && onDisk["123"] === "done" && Object.keys(onDisk).length === 1,
    { onDisk },
  );

  const dbgAfter = await gwDebug();
  check(
    "[守卫] 盘回来后 /api/_debug.bufStates 反映重载的盘上态(123=done)",
    (dbgAfter.bufStates || {})["123"] === "done",
    { bufStates: dbgAfter.bufStates },
  );
  check(
    "[守卫] 盘回来后 extra_protect 也被重载(321)",
    (dbgAfter.extraProtect || []).includes("321"),
    { extraProtect: dbgAfter.extraProtect },
  );

  // 6) 失败信号自证: 若守卫失效(退回 always-flush), onDisk 会是 {} 且 bufStates 为空 -> 上面两条 FAIL。
  check(
    "[守卫] 失败信号确认: onDisk 非空对象(旧 bug 会被覆盖成 {})",
    onDisk && Object.keys(onDisk).length > 0,
    { onDiskKeys: Object.keys(onDisk || {}) },
  );
}

// ================= 启停 + 主流程 =================
async function setup() {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "yd_recguard_"));
  MNT = path.join(TMPDIR, "mnt");
  CACHE_DIR = path.join(MNT, "cache");
  THUMB_DIR = path.join(TMPDIR, "thumbs");
  SEEDED = path.join(TMPDIR, "seeded");
  await fs.mkdir(THUMB_DIR, { recursive: true });
  assertIsolatedPaths();

  try { await fs.access(PROD_REQ); }
  catch { throw new Error(`缺 req.txt(${PROD_REQ}), 无法起隔离网关`); }
}

async function teardown() {
  killGatewayHard();
  try { if (gwChild && gwChild.pid) process.kill(-gwChild.pid, "SIGKILL"); } catch { /* */ }
  if (TMPDIR && TMPDIR.startsWith(os.tmpdir())) {
    try { await fs.rm(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
    console.log(`[teardown] removed TMPDIR ${TMPDIR}`);
  }
}

async function main() {
  await setup();
  try {
    await run();
  } finally {
    await teardown();
  }
  const allOk = results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
  console.log(`ALL PASS: ${allOk}`);
  process.exit(allOk ? 0 : 1);
}

main().catch(async (e) => {
  console.error("e2e error:", e);
  try { await teardown(); } catch { /* */ }
  process.exit(2);
});
