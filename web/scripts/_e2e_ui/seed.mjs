#!/usr/bin/env node
// LANE B — seed the ISOLATED sqlite DB for the cache-controls UI e2e harness.
//
// Creates + migrates the DB at DB_FILE (cfg) and seeds:
//   - 1 Course (PRODUCT_ID 900001, COURSE_NAME)
//   - 3 Video rows (LESSONS from cfg), each with a Video.raw JSON whose `clarity`
//     points at the FAKE ORIGIN (HD_URL/LD_URL). This is the exact shape the web
//     returns to the browser: getCourseVideos() does `JSON.parse(r.raw)` and hands
//     it straight to the frontend Video type. So raw MUST carry every field the
//     settings page / batch payloads read:
//       clarity[] (type+url, fake origin), contentId, cardPackageId, productId,
//       duration, locked:false, kind:"vod", videoId, title, downloadUrl.
//   - SyncMeta `videosSchema:<productId>` = "v2-live"  (CRITICAL: without this,
//     getCourseVideos() treats the rows as a stale schema and re-syncs from the
//     gateway → a REAL network call we must never make. With it, the DB rows are
//     served as-is.)
//   - SyncMeta `courses` (cosmetic: marks catalog synced count).
//
// Idempotent: wipe-and-reseed the one product (delete cascades Videos), then re-create.
//
// Migrate first via prisma migrate deploy, THEN insert with prisma client.
// Run:  node web/scripts/_e2e_ui/seed.mjs   (from worktree root, or anywhere — uses cfg paths)

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT, DB_FILE, DATABASE_URL, PRODUCT_ID, COURSE_NAME, LESSONS, HD_URL, LD_URL,
} from "./cfg.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, "..", ".."); // .../web

// The web app keys schema freshness off this exact string (web/src/lib/catalog.ts:VIDEOS_SCHEMA).
// Must match or getCourseVideos() will try to re-pull from the gateway (network).
const VIDEOS_SCHEMA = "v2-live";

function log(...a) { console.log("[seed]", ...a); }

// One Video.raw object. Mirrors the youdao /api/course video shape closely enough
// that pickM3u8 (highest-type clarity url) and pickLow (lowest-type) both resolve
// to the fake origin, and contentId/cardPackageId/duration/locked/kind are present
// for the batch buffer/thumb payloads.
function buildVideoRaw(l) {
  return {
    videoId: l.videoId,
    productId: PRODUCT_ID,
    title: l.title,
    contentId: l.contentId,
    cardPackageId: l.cardPackageId,
    duration: l.duration,
    locked: false,
    kind: "vod",
    downloadUrl: HD_URL, // pickM3u8 fallback when clarity empty; here clarity wins
    // clarity sorted-by-type: type 2 = HD (highest, pickM3u8), type 1 = LD (lowest, pickLow→thumbSrc).
    clarity: [
      { type: 2, url: HD_URL },
      { type: 1, url: LD_URL },
    ],
    // catalog/live fields the frontend type tolerates; null for plain vod.
    liveId: null,
    liveTab: null,
    year: null,
    month: null,
    module: null,
    topic: null,
    examKey: null,
    startTime: null,
  };
}

function buildCourseRaw() {
  return {
    id: PRODUCT_ID,
    name: COURSE_NAME,
    cardType: null,
    authors: ["e2e"],
  };
}

async function main() {
  mkdirSync(ROOT, { recursive: true });

  // 1) Migrate the isolated DB. prisma reads DATABASE_URL from env (schema: env("DATABASE_URL")).
  log("migrate deploy →", DB_FILE);
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: WEB_DIR,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL },
  });

  // 2) Insert via prisma client. Import AFTER migrate so the generated client exists,
  //    and force the env so the client connects to the isolated DB (not prod).
  process.env.DATABASE_URL = DATABASE_URL;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  try {
    // Idempotent wipe-and-reseed of just our product (Video cascades on Course delete,
    // but delete explicitly to be safe across schema variations).
    await prisma.video.deleteMany({ where: { productId: PRODUCT_ID } });
    await prisma.course.deleteMany({ where: { productId: PRODUCT_ID } });

    await prisma.course.create({
      data: {
        productId: PRODUCT_ID,
        name: COURSE_NAME,
        raw: JSON.stringify(buildCourseRaw()),
      },
    });

    for (const l of LESSONS) {
      await prisma.video.create({
        data: {
          videoId: l.videoId,
          productId: PRODUCT_ID,
          title: l.title,
          idx: l.idx,
          raw: JSON.stringify(buildVideoRaw(l)),
        },
      });
    }

    // CRITICAL: mark this course's videos as current-schema so getCourseVideos()
    // serves DB rows instead of re-syncing from the gateway (real network).
    await prisma.syncMeta.upsert({
      where: { key: `videosSchema:${PRODUCT_ID}` },
      create: { key: `videosSchema:${PRODUCT_ID}`, value: VIDEOS_SCHEMA },
      update: { value: VIDEOS_SCHEMA },
    });
    // Mark catalog synced count (so getCourses() doesn't think the catalog is empty).
    await prisma.syncMeta.upsert({
      where: { key: "courses" },
      create: { key: "courses", value: "1" },
      update: { value: "1" },
    });

    const cCount = await prisma.course.count();
    const vCount = await prisma.video.count({ where: { productId: PRODUCT_ID } });
    log(`seeded: courses=${cCount} videos(product ${PRODUCT_ID})=${vCount}`);
    log(`lessons: ${LESSONS.map((l) => l.videoId).join(", ")}`);
    log("HD_URL:", HD_URL, "LD_URL:", LD_URL);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[seed] FAILED", e);
  process.exit(1);
});
