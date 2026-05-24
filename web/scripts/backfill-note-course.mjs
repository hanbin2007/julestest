// 一次性回填:给迁移前已存在、缺 productId 的 Note / ChatMessage / ChatThread 补上
// productId + (Note 还补 courseName/lessonTitle) 课程身份快照。
// 口径与 catalogRollup.byVid 一致(课程按 productId 升序遍历、同 videoId 后者覆盖 → 最大
// productId 的那门课胜出),保证回填后已有笔记的显示课程与回填前完全一致。
// 老笔记只存了 videoId,原始所属课无法 100% 还原,这是 best-effort。
// 用法: DATABASE_URL=... node web/scripts/backfill-note-course.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [courses, videos] = await Promise.all([
    prisma.course.findMany({ orderBy: { productId: "asc" } }),
    prisma.video.findMany({ orderBy: [{ productId: "asc" }, { idx: "asc" }] }),
  ]);
  const nameByPid = new Map();
  for (const c of courses) {
    let name = c.name;
    try {
      name = JSON.parse(c.raw)?.name ?? c.name;
    } catch {}
    nameByPid.set(c.productId, name);
  }
  // byVid:同 videoId 取「最后遍历到」(最大 productId)的课，与 rollup.byVid 一致
  const byVid = new Map();
  for (const v of videos) {
    byVid.set(v.videoId, {
      productId: v.productId,
      courseName: nameByPid.get(v.productId) ?? null,
      lessonTitle: v.title ?? null,
    });
  }

  let noteN = 0;
  for (const n of await prisma.note.findMany({ where: { productId: null } })) {
    const m = byVid.get(n.videoId);
    if (!m) continue;
    await prisma.note.update({
      where: { id: n.id },
      data: { productId: m.productId, courseName: m.courseName, lessonTitle: m.lessonTitle },
    });
    noteN++;
  }

  let msgN = 0;
  for (const m of await prisma.chatMessage.findMany({ where: { productId: null } })) {
    const hit = byVid.get(m.videoId);
    if (!hit) continue;
    await prisma.chatMessage.update({ where: { id: m.id }, data: { productId: hit.productId } });
    msgN++;
  }

  let thrN = 0;
  for (const t of await prisma.chatThread.findMany({ where: { productId: null } })) {
    const hit = byVid.get(t.videoId);
    if (!hit) continue;
    await prisma.chatThread.update({ where: { videoId: t.videoId }, data: { productId: hit.productId } });
    thrN++;
  }

  console.log(`backfilled: Note=${noteN} ChatMessage=${msgN} ChatThread=${thrN}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
