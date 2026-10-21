import {
  AuthConfigurationError,
  getBearerToken,
  jsonResponse,
  toPublicUser,
  verifyAuthToken,
  withAuthServices,
} from "@/src/lib/auth";
import { preflight, withCors } from "@/src/lib/worker-api/common";

export const dynamic = "force-dynamic";

const respond = (request: Request, body: Record<string, unknown>, status = 200) =>
  withCors(request, jsonResponse(body, status));

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) {
    return respond(request, { ok: false, error: "الجلسة غير صالحة." }, 401);
  }

  try {
    return await withAuthServices(async ({ prisma, tokenSecret }) => {
      let userId: number;
      try {
        userId = await verifyAuthToken(token, tokenSecret);
      } catch {
        return respond(request, { ok: false, error: "انتهت صلاحية الجلسة." }, 401);
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return respond(request, { ok: false, error: "الجلسة غير صالحة." }, 401);
      }
      return respond(request, { ok: true, user: toPublicUser(user) });
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return respond(request,
        { ok: false, error: "خدمة المصادقة غير مهيأة حالياً." },
        503,
      );
    }
    return respond(request,
      { ok: false, error: "تعذر التحقق من الجلسة حالياً." },
      500,
    );
  }
}
