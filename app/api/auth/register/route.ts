import {
  AuthConfigurationError,
  hashPassword,
  isUniqueConstraintError,
  jsonResponse,
  parseCredentials,
  signAuthToken,
  toPublicUser,
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
      const existingUser = await prisma.user.findUnique({
        where: { phone: parsed.credentials.phone },
      });
      if (existingUser) {
        return jsonResponse(
          { ok: false, error: "رقم الهاتف مسجل بالفعل." },
          409,
        );
      }

      const passwordHash = await hashPassword(parsed.credentials.password);
      try {
        const user = await prisma.user.create({
          data: {
            phone: parsed.credentials.phone,
            password: passwordHash,
          },
        });
        const token = await signAuthToken(user, tokenSecret);
        return jsonResponse(
          { ok: true, user: toPublicUser(user), token },
          201,
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return jsonResponse(
            { ok: false, error: "رقم الهاتف مسجل بالفعل." },
            409,
          );
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return jsonResponse(
        { ok: false, error: "خدمة المصادقة غير مهيأة حالياً." },
        503,
      );
    }
    return jsonResponse(
      { ok: false, error: "تعذر إنشاء الحساب حالياً." },
      500,
    );
  }
}
