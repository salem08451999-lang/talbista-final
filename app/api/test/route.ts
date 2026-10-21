import { preflight, withCors } from "@/src/lib/worker-api/common";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withCors(request, Response.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  ));
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
