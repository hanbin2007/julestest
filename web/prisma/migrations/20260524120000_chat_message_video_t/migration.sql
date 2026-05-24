-- 提问时的播放位置(秒)。存 AI 问答为笔记时，用它作截图/跳转的时间锚点，
-- 而不是「点保存那一刻」的 currentTime（可能早已快进/暂停后移动）。
ALTER TABLE "ChatMessage" ADD COLUMN "videoT" INTEGER;
