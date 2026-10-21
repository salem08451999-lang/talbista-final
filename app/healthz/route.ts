import { d1 } from "@/src/lib/worker-api/common";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await d1().prepare("SELECT 1").first();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
