import { promises as fs } from "fs";
import path from "path";
import os from "os";

// Claude 助教的附图（用户发的批注画面，JPEG）落盘到 app.db 同目录的 chat-imgs/，
// 文件名 = 消息 id。另外 claude-chat/ 作为 Agent SDK 会话 JSONL 的固定 cwd。

function dataDir(): string {
  const url = process.env.DATABASE_URL ?? "";
  const m = url.match(/^file:(.+)$/);
  if (m) return path.dirname(m[1]);
  return path.join(os.homedir(), ".youdao_course");
}

export function chatImgDir(): string {
  return path.join(dataDir(), "chat-imgs");
}
export function chatSessionDir(): string {
  return path.join(dataDir(), "claude-chat");
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}
function imgPath(id: string): string {
  return path.join(chatImgDir(), `${safeId(id)}.jpg`);
}

export async function saveChatImage(id: string, jpeg: Buffer): Promise<void> {
  await fs.mkdir(chatImgDir(), { recursive: true });
  await fs.writeFile(imgPath(id), jpeg);
}

export async function readChatImage(id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(imgPath(id));
  } catch {
    return null;
  }
}

// 清空对话时连带删掉这些消息的附图文件（best-effort，删失败不报错）。
export async function deleteChatImages(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => fs.rm(imgPath(id), { force: true }).catch(() => {})));
}
