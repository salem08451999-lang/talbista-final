"use client";

import { useEffect, useState, type FormEvent } from "react";

type AuthUser = {
  id: number;
  phone: string;
  createdAt: string;
};

type AuthResult = {
  ok?: boolean;
  user?: AuthUser;
  token?: string;
  error?: string;
};

const TOKEN_KEY = "talbista.auth.token";
const USER_KEY = "talbista.auth.user";

type Mode = "login" | "register";

export default function Home() {
  const [mode, setMode] = useState<Mode>("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function restoreSession() {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        if (active) setCheckingSession(false);
        return;
      }

      try {
        const response = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const result = (await response.json().catch(() => null)) as AuthResult | null;
        if (!active) return;

        if (response.ok && result?.user) {
          localStorage.setItem(USER_KEY, JSON.stringify(result.user));
          setUser(result.user);
        } else if (response.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
        } else {
          setSavedToken(token);
          setError("تعذر التحقق من الجلسة الآن. أعد المحاولة دون إدخال بياناتك من جديد.");
        }
      } catch {
        if (active) {
          setSavedToken(token);
          setError("تعذر الاتصال بالخادم للتحقق من الجلسة. أعد المحاولة لاحقاً.");
        }
      } finally {
        if (active) setCheckingSession(false);
      }
    }

    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, password }),
        },
      );
      const result = (await response.json().catch(() => null)) as AuthResult | null;
      if (!response.ok || !result?.user || !result.token) {
        throw new Error(result?.error || "تعذر إتمام العملية. حاول مرة أخرى.");
      }

      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(USER_KEY, JSON.stringify(result.user));
      setUser(result.user);
      setSavedToken(null);
      setPassword("");
      setMessage(
        mode === "login" ? "تم تسجيل الدخول بنجاح." : "تم إنشاء الحساب وتسجيل الدخول.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "تعذر الاتصال بالخادم. حاول مرة أخرى.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function retrySession() {
    if (!savedToken) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${savedToken}` },
        cache: "no-store",
      });
      const result = (await response.json().catch(() => null)) as AuthResult | null;
      if (!response.ok || !result?.user) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        setSavedToken(null);
        setError("انتهت صلاحية الجلسة. سجّل الدخول من جديد.");
        return;
      }
      localStorage.setItem(USER_KEY, JSON.stringify(result.user));
      setUser(result.user);
      setSavedToken(null);
    } catch {
      setError("تعذر الاتصال بالخادم للتحقق من الجلسة. أعد المحاولة لاحقاً.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setError("");
    setMessage("");
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    setPhone("");
    setPassword("");
    setError("");
    setMessage("تم تسجيل الخروج.");
  }

  return (
    <main dir="rtl" className="flex min-h-screen items-center justify-center bg-[#0a1a14] px-5 py-10 text-white">
      <section className="w-full max-w-md rounded-3xl border border-[#c8ad72]/30 bg-[#10251c] p-7 shadow-2xl shadow-black/30 sm:p-9">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#c8ad72]/50 bg-[#c8ad72]/10 text-2xl font-bold text-[#e3ca8d]">
            ط
          </div>
          <p className="mb-2 text-sm font-medium tracking-wide text-[#e3ca8d]">طلبيستا</p>
          <h1 className="text-2xl font-semibold">
            {user ? "أهلاً بك" : mode === "login" ? "تسجيل الدخول" : "إنشاء حساب"}
          </h1>
          <p className="mt-2 text-sm text-white/65">
            {user ? "تم تسجيل دخولك إلى حسابك." : "استخدم رقم هاتفك وكلمة المرور فقط."}
          </p>
        </div>

        {checkingSession ? (
          <p className="py-5 text-center text-sm text-white/70">جارٍ التحقق من الجلسة…</p>
        ) : user ? (
          <div className="space-y-5 text-center">
            <div className="rounded-2xl border border-white/10 bg-black/10 px-4 py-4">
              <p className="text-xs text-white/55">رقم الهاتف</p>
              <p dir="ltr" className="mt-1 font-medium text-[#e3ca8d]">{user.phone}</p>
            </div>
            {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
            <button
              type="button"
              onClick={signOut}
              className="w-full rounded-xl border border-white/15 px-4 py-3 font-medium text-white transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ca8d]"
            >
              تسجيل الخروج
            </button>
          </div>
        ) : savedToken ? (
          <div className="space-y-4 text-center">
            {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
            <button
              type="button"
              disabled={busy}
              onClick={() => void retrySession()}
              className="w-full rounded-xl bg-[#d3b977] px-4 py-3 font-semibold text-[#102018] transition hover:bg-[#e3ca8d] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "جارٍ التحقق…" : "إعادة التحقق من الجلسة"}
            </button>
            <button
              type="button"
              onClick={signOut}
              className="w-full rounded-xl border border-white/15 px-4 py-3 text-sm text-white/80 transition hover:bg-white/5"
            >
              استخدام حساب آخر
            </button>
          </div>
        ) : (
          <form onSubmit={submitCredentials} className="space-y-5">
            <label className="block space-y-2 text-sm">
              <span className="text-white/85">رقم الهاتف</span>
              <input
                autoComplete="tel"
                dir="ltr"
                inputMode="tel"
                name="phone"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="09xxxxxxxx"
                className="w-full rounded-xl border border-white/15 bg-[#091810] px-4 py-3 text-left text-white outline-none transition placeholder:text-white/35 focus:border-[#d3b977] focus:ring-2 focus:ring-[#d3b977]/20"
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span className="text-white/85">كلمة المرور</span>
              <input
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                name="password"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="8 أحرف على الأقل"
                className="w-full rounded-xl border border-white/15 bg-[#091810] px-4 py-3 text-right text-white outline-none transition placeholder:text-white/35 focus:border-[#d3b977] focus:ring-2 focus:ring-[#d3b977]/20"
              />
            </label>

            {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
            {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-[#d3b977] px-4 py-3 font-semibold text-[#102018] transition hover:bg-[#e3ca8d] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ca8d]"
            >
              {busy
                ? "جارٍ المعالجة…"
                : mode === "login"
                  ? "تسجيل الدخول"
                  : "إنشاء الحساب"}
            </button>

            <button
              type="button"
              onClick={() => switchMode(mode === "login" ? "register" : "login")}
              className="w-full py-2 text-sm text-[#e3ca8d] transition hover:text-white"
            >
              {mode === "login" ? "ليس لديك حساب؟ إنشاء حساب" : "لديك حساب؟ تسجيل الدخول"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
