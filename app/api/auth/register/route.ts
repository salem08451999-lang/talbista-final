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
import { preflight, withCors } from "@/src/lib/worker-api/common";

export const dynamic = "force-dynamic";

const respond = (request: Request, body: Record<string, unknown>, status = 200) =>
  withCors(request, jsonResponse(body, status));

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsed = parseCredentials(body);
  if (!parsed.credentials) {
    return respond(request, { ok: false, error: parsed.error }, 400);
  }

  try {
    return await withAuthServices(async ({ prisma, tokenSecret }) => {
      const existingUser = await prisma.user.findUnique({
        where: { phone: parsed.credentials.phone },
      });
      if (existingUser) {
        return respond(request,
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
        return respond(request,
          { ok: true, user: toPublicUser(user), token },
          201,
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return respond(request,
            { ok: false, error: "رقم الهاتف مسجل بالفعل." },
            409,
          );
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return respond(request,
        { ok: false, error: "خدمة المصادقة غير مهيأة حالياً." },
        503,
      );
    }
    return respond(request,
      { ok: false, error: "تعذر إنشاء الحساب حالياً." },
      500,
    );
  }
}
