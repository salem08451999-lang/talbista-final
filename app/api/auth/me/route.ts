import {
  AuthConfigurationError,
  getBearerToken,
  jsonResponse,
  toPublicUser,
  verifyAuthToken,
  withAuthServices,
} from "@/src/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ ok: false, error: "الجلسة غير صالحة." }, 401);
  }

  try {
    return await withAuthServices(async ({ prisma, tokenSecret }) => {
      let userId: number;
      try {
        userId = await verifyAuthToken(token, tokenSecret);
      } catch {
        return jsonResponse({ ok: false, error: "انتهت صلاحية الجلسة." }, 401);
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return jsonResponse({ ok: false, error: "الجلسة غير صالحة." }, 401);
      }
      return jsonResponse({ ok: true, user: toPublicUser(user) });
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return jsonResponse(
        { ok: false, error: "خدمة المصادقة غير مهيأة حالياً." },
        503,
      );
    }
    return jsonResponse(
      { ok: false, error: "تعذر التحقق من الجلسة حالياً." },
      500,
    );
  }
}
