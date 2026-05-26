import { z } from "zod";

// 写接口(POST)入参的集中校验。原先各路由用裸 Number()/String() 手工兜底，容易漏判；
// 这里收敛为 zod schema，解析失败统一返回 400 + 可读的字段错误。
// 数值用 z.coerce 保留原先 Number() 的宽松（前端偶尔传字符串数字也能过）。

// 矢量批注 JSON 文本（v2 {v:2,objects[]} 序列化）。压感样本点更密，上限 256KB→1MB。
const strokesField = z.string().max(1_048_576).optional();

export const noteAddSchema = z.object({
  videoId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int().nullish().catch(null), // 课程身份(创建时绑课);缺失→读路径兜底
  text: z.string().trim().min(1),
  t: z.coerce.number().int().min(0).catch(0), // 时间戳秒，非法→0（同原 Math.floor(Number||0)）
  strokes: strokesField,
});

export const noteUpdateSchema = z.object({
  videoId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int().nullish().catch(null), // 课程身份;用于回包列表按 (videoId,productId) 收窄,旧客户端可省
  id: z.string().min(1),
  text: z.string().trim().min(1),
  strokes: strokesField,
});

// 内置 Claude 助教：发消息入参。image 为可选的 dataURL（批注画面截图）。
// chatId 必填：新建 chat 走 /api/chat/new 拿到 id 后再发消息（两步），这样客户端 stream
// 状态从 t=0 就以 chatId 为键，免去 "pending → real" 换键的复杂度，是支撑后台并行的关键。
// currentProductId/videoId = 发送时所看的讲(与 chat 绑定可能不同)，用于:
//   1) 写入 ChatMessage.productId/videoId 让 videoT 跳回正确;
//   2) 仅 chat.kind==='lesson' 时注入 system 上下文(课程名/讲名)。
export const chatSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().trim().min(1),
  image: z.string().startsWith("data:image/").max(6_000_000).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  videoT: z.coerce.number().int().min(0).optional(),
  currentProductId: z.coerce.number().int().nullish().catch(null),
  currentVideoId: z.coerce.number().int().nullish().catch(null),
});

// 创建新 chat：kind=lesson 必带 productId+videoId;independent 两者必须缺省。
export const chatNewSchema = z
  .object({
    kind: z.enum(["lesson", "independent"]),
    productId: z.coerce.number().int().optional(),
    videoId: z.coerce.number().int().positive().optional(),
  })
  .refine(
    (d) =>
      d.kind === "lesson"
        ? d.productId != null && d.videoId != null
        : d.productId == null && d.videoId == null,
    { message: "lesson 需带 productId+videoId;independent 不可带" },
  );

// 重命名 chat：服务端会再 trim,空串拒,长度 ≤120 字。
export const chatRenameSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
});

export const chatDeleteSchema = z.object({
  chatId: z.string().min(1),
});

export const noteDeleteSchema = z.object({
  videoId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int().nullish().catch(null), // 课程身份;用于回包列表按 (videoId,productId) 收窄,旧客户端可省
  id: z.string().min(1),
});

export const progressSchema = z.object({
  videoId: z.coerce.number().int().positive(),
  t: z.coerce.number().min(0).catch(0),
  d: z.coerce.number().min(0).catch(0),
  productId: z.coerce.number().int(), // 必填:Progress 主键为 (productId,videoId);前端始终上报真实 productId
  title: z.string().nullish(),
  courseName: z.string().nullish(),
});

/**
 * 解析并校验请求体。成功返回 {data}；失败返回 {error: 400 Response}，调用方直接 return。
 * 请求体非 JSON 时按空对象处理（由 schema 决定缺字段是否报错）。
 */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ data: T; error?: undefined } | { data?: undefined; error: Response }> {
  const raw = await req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  if (!r.success) {
    const msg =
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") ||
      "invalid body";
    return { error: Response.json({ error: msg }, { status: 400 }) };
  }
  return { data: r.data };
}
