import {
  AuthConfigurationError,
  jsonResponse,
  parseCredentials,
  signAuthToken,
  toPublicUser,
  verifyPassword,
  withAuthServices,
} from "@/src/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsed = parseCredentials(body);
  if (!parsed.credentials) {
    return jsonResponse({ ok: false, error: parsed.error }, 400);
  }

  try {
    return await withAuthServices(async ({ prisma, tokenSecret }) => {
      const user = await prisma.user.findUnique({
        where: { phone: parsed.credentials.phone },
      });
      if (
        !user ||
        !(await verifyPassword(parsed.credentials.password, user.password))
      ) {
        return jsonResponse(
          { ok: false, error: "رقم الهاتف أو كلمة المرور غير صحيحة." },
          401,
        );
      }

      const token = await signAuthToken(user, tokenSecret);
      return jsonResponse({ ok: true, user: toPublicUser(user), token });
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return jsonResponse(
        { ok: false, error: "خدمة المصادقة غير مهيأة حالياً." },
        503,
      );
    }
    return jsonResponse(
      { ok: false, error: "تعذر تسجيل الدخول حالياً." },
      500,
    );
  }
}
