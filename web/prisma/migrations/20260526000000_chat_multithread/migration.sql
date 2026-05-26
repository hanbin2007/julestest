-- 多聊天 + 后台并行 + 进度/停止
-- 替换 ChatThread 为 Chat（带 id），给 ChatMessage 加 chatId FK。
-- 旧的每条 ChatThread 行变成一个 lesson 类 Chat（保留 sessionId），孤儿消息组（无对应
-- ChatThread 或 productId NULL）也补一行 Chat 兜底。回填 id 用 "legacy-{pid}-{vid}"
-- 是确定性的，配合 ON CONFLICT 与 _prisma_migrations 表，整脚本幂等可重跑。

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- 1. Chat 表（CHECK 保证 kind 与 productId/videoId 一致）
CREATE TABLE "Chat" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "productId" INTEGER,
  "videoId" INTEGER,
  "title" TEXT,
  "sessionId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CHECK (
    (kind='lesson'      AND productId IS NOT NULL AND videoId IS NOT NULL) OR
    (kind='independent' AND productId IS NULL     AND videoId IS NULL)
  )
);
CREATE INDEX "Chat_productId_videoId_updatedAt_idx" ON "Chat"("productId","videoId","updatedAt");
CREATE INDEX "Chat_kind_updatedAt_idx"              ON "Chat"("kind","updatedAt");

-- 2. 旧 ChatThread → 同名 lesson 类 Chat（每条 thread 变成一个初始 chat，sessionId 保留）
INSERT INTO "Chat" ("id","kind","productId","videoId","sessionId","createdAt","updatedAt")
SELECT
  printf('legacy-%d-%d', "productId", "videoId"),
  'lesson', "productId", "videoId", "sessionId", "updatedAt", "updatedAt"
FROM "ChatThread";

-- 3. 孤儿消息组（productId NULL 或没有对应 thread）也补一行 Chat 兜底
INSERT INTO "Chat" ("id","kind","productId","videoId","title","createdAt","updatedAt")
SELECT
  printf('legacy-%d-%d', COALESCE("productId",0), "videoId"),
  'lesson', COALESCE("productId",0), "videoId", NULL, MIN("at"), MAX("at")
FROM "ChatMessage"
GROUP BY COALESCE("productId",0), "videoId"
ON CONFLICT(id) DO NOTHING;

-- 4. 给 ChatMessage 加 chatId 列 + 回填
ALTER TABLE "ChatMessage" ADD COLUMN "chatId" TEXT;
UPDATE "ChatMessage"
   SET "chatId" = printf('legacy-%d-%d', COALESCE("productId",0), "videoId");

-- 5. 重建 ChatMessage：把 chatId 改 NOT NULL + 装 FK，顺手把 videoId 改可空（语义已变）
CREATE TABLE "new_ChatMessage" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "chatId"    TEXT NOT NULL,
  "videoId"   INTEGER,
  "productId" INTEGER,
  "role"      TEXT NOT NULL,
  "text"      TEXT NOT NULL,
  "image"     TEXT,
  "videoT"    INTEGER,
  "at"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChatMessage" ("id","chatId","videoId","productId","role","text","image","videoT","at")
  SELECT "id","chatId","videoId","productId","role","text","image","videoT","at" FROM "ChatMessage";
DROP TABLE "ChatMessage";
ALTER TABLE "new_ChatMessage" RENAME TO "ChatMessage";
CREATE INDEX "ChatMessage_chatId_at_idx"          ON "ChatMessage"("chatId","at");
CREATE INDEX "ChatMessage_productId_videoId_idx"  ON "ChatMessage"("productId","videoId");

-- 6. 旧 ChatThread 退场
DROP TABLE "ChatThread";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
