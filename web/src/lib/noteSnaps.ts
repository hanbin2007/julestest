import { promises as fs } from "fs";
import path from "path";
import os from "os";

// 笔记手动截图（记笔记时抓当前画面）落盘到 app.db 同目录下的 note-snaps/。
// 与缩略图雪碧图(网关 /thumbs)无关：这是用户在记笔记那一刻的精确帧，即时可得。

function dataDir(): string {
  const url = process.env.DATABASE_URL ?? "";
  const m = url.match(/^file:(.+)$/);
  if (m) return path.dirname(m[1]);
  return path.join(os.homedir(), ".youdao_course");
}

export function snapDir(): string {
  return path.join(dataDir(), "note-snaps");
}

// note id 由 add 端点生成（`${Date.now()}-${rand}`），形如 1779536155509-ab3kq。
const SNAP_FILE = /^\d+-[a-z0-9]+\.jpg$/;
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}
export function snapPath(id: string): string {
  return path.join(snapDir(), `${safeId(id)}.jpg`);
}

export async function saveSnap(id: string, jpeg: Buffer): Promise<void> {
  await fs.mkdir(snapDir(), { recursive: true });
  await fs.writeFile(snapPath(id), jpeg);
}

export async function readSnap(id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(snapPath(id));
  } catch {
    return null;
  }
}

export async function deleteSnaps(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => fs.rm(snapPath(id), { force: true }).catch(() => {})));
}

// 一次 readdir 列出全部有截图的 note id（供 /api/notes/all 标 hasSnap）。
// 规模权衡：随截图数线性增长；数千以内无虞，若以后量大可加短 TTL 缓存或在存/删时增量维护。
export async function listSnapIds(): Promise<Set<string>> {
  try {
    const files = await fs.readdir(snapDir());
    return new Set(files.filter((f) => SNAP_FILE.test(f)).map((f) => f.slice(0, -4)));
  } catch {
    return new Set();
  }
}
