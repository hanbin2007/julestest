import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getCatalogRollup } from "@/lib/catalogRollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 聊天列表(无分页 — 单机数据量小):
//   ?scope=lesson&productId=<p>&videoId=<v>  → 本讲所有 chat(切换器用)
//   ?scope=independent                       → 全部独立 chat(中心页独立分组)
//   (无参/scope=all)                          → 全部 chat(中心页总览)
// 富化:每条带 messageCount + lastMessage(role/text/at) + 课程/讲名(三级回退,与 /api/notes/all 同款)。
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const scope = sp.get("scope") || "all";
  const productId = sp.get("productId") ? Number(sp.get("productId")) : null;
  const videoId = sp.get("videoId") ? Number(sp.get("videoId")) : null;

  let where: { kind?: string; productId?: number; videoId?: number } = {};
  if (scope === "lesson") {
    if (!productId || !videoId)
      return Response.json({ error: "lesson scope requires productId+videoId" }, { status: 400 });
    where = { kind: "lesson", productId, videoId };
  } else if (scope === "independent") {
    where = { kind: "independent" };
  } // else: all → 空 where

  const chats = await prisma.chat.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });

  // 一次 groupBy 取每条 chat 的消息数 + 最后一条 at;再一次单条查询拼 lastMessage 内容。
  // 数据量小,直接 N+1 取 lastMessage 也 OK,但 groupBy 走更稳。
  const counts = await prisma.chatMessage.groupBy({
    by: ["chatId"],
    where: { chatId: { in: chats.map((c) => c.id) } },
    _count: { _all: true },
    _max: { at: true },
  });
  const cntMap = new Map(counts.map((c) => [c.chatId, c]));
  const lastIds = counts
    .map((c) => ({ chatId: c.chatId, at: c._max.at }))
    .filter((c): c is { chatId: string; at: Date } => !!c.at);
  const lastRows = lastIds.length
    ? await prisma.chatMessage.findMany({
        where: {
          OR: lastIds.map((l) => ({ chatId: l.chatId, at: l.at })),
        },
        select: { chatId: true, role: true, text: true, at: true },
      })
    : [];
  const lastMap = new Map(lastRows.map((r) => [r.chatId, r]));

  // 富化课程/讲名(三级回退:目录 live → null → null;chat 自己没存快照,只能靠目录)。
  const rollup = await getCatalogRollup();

  const enriched = chats.map((c) => {
    const cnt = cntMap.get(c.id);
    const last = lastMap.get(c.id);
    let courseName: string | null = null;
    let lessonTitle: string | null = null;
    if (c.kind === "lesson" && c.productId != null && c.videoId != null) {
      const meta = rollup.byCourseVid.get(`${c.productId}:${c.videoId}`);
      if (meta) {
        courseName = meta.courseName ?? null;
        lessonTitle = meta.title ?? null;
      }
    }
    return {
      id: c.id,
      kind: c.kind,
      productId: c.productId,
      videoId: c.videoId,
      title: c.title,
      sessionId: c.sessionId ? "set" : null, // 不暴露真值,只告知有无续接能力
      createdAt: c.createdAt.getTime(),
      updatedAt: c.updatedAt.getTime(),
      messageCount: cnt?._count._all ?? 0,
      lastMessage: last
        ? { role: last.role, text: last.text, at: last.at.getTime() }
        : null,
      courseName,
      lessonTitle,
    };
  });

  const stats = {
    total: enriched.length,
    lesson: enriched.filter((c) => c.kind === "lesson").length,
    independent: enriched.filter((c) => c.kind === "independent").length,
    courses: new Set(
      enriched.filter((c) => c.kind === "lesson" && c.productId != null).map((c) => c.productId),
    ).size,
  };

  return Response.json({ chats: enriched, stats });
}
