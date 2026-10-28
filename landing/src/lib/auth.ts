/**
 * Auth helpers — localStorage tabanlı oturum yönetimi (access + refresh token).
 *
 * - Access token: `lostick.authToken` (kısa ömürlü, ~15 dk)
 * - Refresh token: `lostick.refreshToken` (uzun ömürlü, ~30 gün, tek kullanımlık/rotated)
 * - User: `lostick.authUser` JSON olarak saklanır
 * - Access expiry: `lostick.tokenExpiresAt` (ms, proactive refresh için)
 * - `apiFetch` Authorization header'ını ekler ve 401'de otomatik refresh+retry yapar
 * - State değişiklikleri `lostick:auth-changed`, oturum bitmesi `lostick:session-expired`
 *   event'leri ile yayılır
 */

import { API_BASE } from "./apiKey";

export type Role = "user" | "admin";

export interface User {
  id: number;
  username: string;
  email: string | null;
  role: Role;
}

export const TOKEN_KEY = "lostick.authToken";
export const REFRESH_KEY = "lostick.refreshToken";
export const USER_KEY = "lostick.authUser";
export const EXPIRES_AT_KEY = "lostick.tokenExpiresAt";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(TOKEN_KEY);
  return v && v.trim() ? v : null;
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(REFRESH_KEY);
  return v && v.trim() ? v : null;
}

export function getAuthUser(): User | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getAuthToken() !== null && getAuthUser() !== null;
}

export function isAdmin(): boolean {
  const u = getAuthUser();
  return u?.role === "admin";
}

interface TokenPair {
  token: string;
  refresh_token: string;
  expires_in: number;          // saniye
  refresh_expires_in: number;  // saniye
}

function persistTokens(tokens: TokenPair, user: User | null) {
  window.localStorage.setItem(TOKEN_KEY, tokens.token);
  window.localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
  window.localStorage.setItem(
    EXPIRES_AT_KEY,
    String(Date.now() + tokens.expires_in * 1000),
  );
  if (user) {
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  window.dispatchEvent(new CustomEvent("lostick:auth-changed"));
}

/** İçeride apiFetch'in çağıracağı saf token güncellemesi (user dokunulmaz). */
export function persistRefreshedTokens(
  token: string,
  refreshToken: string,
  expiresIn: number,
) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(REFRESH_KEY, refreshToken);
  window.localStorage.setItem(
    EXPIRES_AT_KEY,
    String(Date.now() + expiresIn * 1000),
  );
  window.dispatchEvent(new CustomEvent("lostick:auth-changed"));
}

export function clearAuthStorage() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(USER_KEY);
  window.localStorage.removeItem(EXPIRES_AT_KEY);
  window.dispatchEvent(new CustomEvent("lostick:auth-changed"));
}

interface AuthResponse {
  token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
  user: User;
}

interface ErrorResponse {
  detail?: string | EmailNotVerifiedError | Record<string, unknown>;
}

/** err.detail string ise döndür, değilse fallback kullan — TS güvenliği için. */
function errMessage(err: ErrorResponse, fallback: string): string {
  if (typeof err.detail === "string") return err.detail;
  if (
    err.detail &&
    typeof err.detail === "object" &&
    "mesaj" in err.detail &&
    typeof (err.detail as { mesaj?: unknown }).mesaj === "string"
  ) {
    return (err.detail as { mesaj: string }).mesaj;
  }
  return fallback;
}

/**
 * Login. Eğer kullanıcının e-postası doğrulanmamışsa backend 403 + structured detail döner.
 * Frontend bu durumu yakalayıp "Doğrulama kodu gir" akışına yönlendirebilmek için
 * EmailNotVerifiedError fırlatırız.
 */
export class NotVerifiedError extends Error {
  info: EmailNotVerifiedError;
  constructor(info: EmailNotVerifiedError) {
    super(info.mesaj);
    this.name = "NotVerifiedError";
    this.info = info;
  }
}

export async function login(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    // 403 + email_not_verified: özel hata sınıfı fırlat
    if (res.status === 403 && isEmailNotVerifiedError(err.detail)) {
      throw new NotVerifiedError(err.detail);
    }
    const msg = typeof err.detail === "string" ? err.detail : "Giriş başarısız oldu.";
    throw new Error(msg);
  }
  const data: AuthResponse = await res.json();
  persistTokens(data, data.user);
  return data;
}

/**
 * Yeni register flow — e-posta doğrulama zorunlu, AUTO-LOGIN YOK.
 * Backend doğrulama kodu üretip e-posta gönderir, frontend kod giriş ekranına geçer.
 */
export interface RegisterPendingResponse {
  durum: "verification_pending";
  user_id: number;
  username: string;
  email: string;
  dev_mode?: boolean;
}

export async function register(
  username: string,
  password: string,
  email: string,
): Promise<RegisterPendingResponse> {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, email }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(errMessage(err, "Kayıt başarısız oldu."));
  }
  // ÖNEMLİ: persistAuth ÇAĞIRMIYORUZ — kullanıcı önce email'i doğrulamalı + sonra login
  return (await res.json()) as RegisterPendingResponse;
}

export async function verifyEmail(
  userId: number,
  code: string,
): Promise<{ durum: string; username?: string }> {
  const res = await fetch(`${API_BASE}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, code }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(errMessage(err, "Doğrulama başarısız."));
  }
  return await res.json();
}

export async function resendVerification(
  userId: number,
): Promise<{ durum: string; email?: string; dev_mode?: boolean }> {
  const res = await fetch(`${API_BASE}/api/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(errMessage(err, "Yeniden gönderim başarısız."));
  }
  return await res.json();
}

/**
 * email_not_verified hatasını yakalayabilmek için type guard.
 * Backend 403 dönüyor, detail bir obje: { kod, user_id, email, mesaj }.
 */
export interface EmailNotVerifiedError {
  kod: "email_not_verified";
  user_id: number;
  email: string;
  mesaj: string;
}

export function isEmailNotVerifiedError(
  detail: unknown,
): detail is EmailNotVerifiedError {
  return (
    typeof detail === "object" &&
    detail !== null &&
    "kod" in detail &&
    (detail as { kod?: string }).kod === "email_not_verified"
  );
}

/**
 * OAuth (Google/GitHub) backend cevabını localStorage'a yazıp event yayar.
 * Backend yanıtının {token, refresh_token, expires_in, ...} tamamı geçirilmelidir.
 */
export function setOAuthSession(tokens: TokenPair, user: User): void {
  persistTokens(tokens, user);
}

export type OAuthMode = "login" | "register";

export async function loginWithGoogle(
  idToken: string,
  mode: OAuthMode = "login",
): Promise<AuthResponse> {
  return _loginGoogleInternal({ credential: idToken, mode });
}

/**
 * google.accounts.oauth2.initTokenClient'tan dönen access_token ile
 * backend'e gider. Custom buton + popup OAuth flow için kullanılır.
 */
export async function loginWithGoogleAccessToken(
  accessToken: string,
  mode: OAuthMode = "login",
): Promise<AuthResponse> {
  return _loginGoogleInternal({ access_token: accessToken, mode });
}

async function _loginGoogleInternal(payload: {
  credential?: string;
  access_token?: string;
  mode: OAuthMode;
}): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/oauth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(
      errMessage(
        err,
        payload.mode === "login"
          ? "Google ile giriş başarısız."
          : "Google ile kayıt başarısız.",
      ),
    );
  }
  const data: AuthResponse = await res.json();
  // ÖNEMLİ: kayıt sırasında AUTO-LOGIN YOK — kullanıcı /login'den tekrar girer
  if (payload.mode === "login") {
    persistTokens(data, data.user);
  }
  return data;
}

export async function loginWithGithub(
  code: string,
  mode: OAuthMode = "login",
): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/oauth/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, mode }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(
      errMessage(
        err,
        mode === "login"
          ? "GitHub ile giriş başarısız."
          : "GitHub ile kayıt başarısız.",
      ),
    );
  }
  const data: AuthResponse = await res.json();
  // ÖNEMLİ: kayıt sırasında AUTO-LOGIN YOK — kullanıcı /login'den tekrar girer
  if (mode === "login") {
    persistTokens(data, data.user);
  }
  return data;
}

export async function logout(): Promise<void> {
  const token = getAuthToken();
  if (token) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // sunucuya ulaşılamasa da localden temizle
    }
  }
  clearAuthStorage();
}

/**
 * Tüm cihazlardaki oturumları sunucu üstünde iptal eder + yerel storage'ı temizler.
 * Şifre değiştirme, hesap ihlali şüphesi veya "tüm cihazlardan çık" akışı için kullan.
 */
export async function logoutAll(): Promise<{ iptal_edilen_oturum: number } | null> {
  const token = getAuthToken();
  if (!token) {
    clearAuthStorage();
    return null;
  }
  let result: { iptal_edilen_oturum: number } | null = null;
  try {
    const res = await fetch(`${API_BASE}/api/auth/logout-all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      result = (await res.json()) as { iptal_edilen_oturum: number };
    }
  } catch {
    // sunucuya ulaşılamasa da localden temizle
  }
  clearAuthStorage();
  return result;
}

/**
 * Refresh token ile yeni access + refresh ikilisi al, localStorage'a yaz.
 * Eş zamanlı çağrılar tek bir in-flight isteği paylaşır (singleton pattern).
 * Refresh başarısız olursa storage temizlenir ve `lostick:session-expired` yayılır
 * → UI bunu yakalayıp kullanıcıyı /login'e yönlendirmeli.
 *
 * Returns: yeni access token | null (refresh kayıp/süresi dolmuş/iptal edilmiş)
 */
let _refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (_refreshInFlight) return _refreshInFlight;

  const refreshToken = getRefreshToken();
  if (!refreshToken) return Promise.resolve(null);

  _refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        clearAuthStorage();
        window.dispatchEvent(new CustomEvent("lostick:session-expired"));
        return null;
      }
      const data = (await res.json()) as {
        token: string;
        refresh_token: string;
        expires_in: number;
        refresh_expires_in: number;
      };
      persistRefreshedTokens(data.token, data.refresh_token, data.expires_in);
      return data.token;
    } catch {
      // Ağ hatasında storage'ı silme — geçici bir kesinti olabilir
      return null;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

export interface ForgotPasswordResponse {
  durum: string;
  user_id: number;
  email: string;
  dev_mode?: boolean;
}

export async function forgotPassword(email: string): Promise<ForgotPasswordResponse> {
  const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(errMessage(err, "Şifre sıfırlama talebi gönderilemedi."));
  }
  return await res.json();
}

export async function resetPassword(userId: number, code: string, newPassword: string): Promise<{ durum: string }> {
  const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, code, new_password: newPassword }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(errMessage(err, "Şifre sıfırlanamadı."));
  }
  return await res.json();
}
