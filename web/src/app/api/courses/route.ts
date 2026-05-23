import { getCourses } from "@/lib/catalog";
import { GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 课程列表:优先从 DB 读;空库才向网关同步一次。不再每次打有道。
export async function GET() {
  try {
    return Response.json({ courses: await getCourses() });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    return Response.json(
      { error: (e as Error).message, courses: [] },
      { status },
    );
  }
}
