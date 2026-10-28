/**
 * BYOK (Bring Your Own Key) yardımcıları.
 *
 * - Kullanıcının Gemini API key'i `localStorage`'da tutulur ('lostick.userApiKey')
 * - `apiFetch` her isteğe `X-User-Api-Key` header'ı ekler (key varsa)
 * - Backend key varsa o key'i kullanır, yoksa sunucu key'inin günlük limitine düşer
 * - Quota dolduğunda backend 429 döner; arayüz ApiKeyDialog'a yönlendirir
 */

export const API_BASE = "http://127.0.0.1:8000";
const STORAGE_KEY = "lostick.userApiKey";

export interface KullanimBilgisi {
  sunucu_key: boolean;
  kalan: number;
  limit: number | null;
  cached: boolean;
}

export function getUserApiKey(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v && v.trim() ? v.trim() : null;
}

export function setUserApiKey(key: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, key.trim());
  // Aynı sekmedeki diğer component'leri bilgilendirmek için event yay
  window.dispatchEvent(new CustomEvent("lostick:api-key-changed"));
}

export function clearUserApiKey(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent("lostick:api-key-changed"));
  window.dispatchEvent(
    new CustomEvent("lostick:toast", {
      detail: { message: "Tüm API anahtarları kaldırıldı.", type: "warning" }
    })
  );
}

export function hasUserApiKey(): boolean {
  return getUserApiKey() !== null;
}

export function getUserApiKeys(): string[] {
  const raw = getUserApiKey();
  if (!raw) return [];
  return raw.split(",").map(k => k.trim()).filter(k => k.length > 0);
}

export function setUserApiKeys(keys: string[]): void {
  const cleanKeys = keys.map(k => k.trim()).filter(k => k.length > 0);
  if (cleanKeys.length === 0) {
    clearUserApiKey();
  } else {
    setUserApiKey(cleanKeys.join(","));
  }
}

export function addUserApiKey(key: string): void {
  const current = getUserApiKeys();
  const trimmed = key.trim();
  if (trimmed && !current.includes(trimmed)) {
    setUserApiKeys([...current, trimmed]);
    window.dispatchEvent(
      new CustomEvent("lostick:toast", {
        detail: { message: "API anahtarı başarıyla eklendi!", type: "success" }
      })
    );
  }
}

export function removeUserApiKey(key: string): void {
  const current = getUserApiKeys();
  const trimmed = key.trim();
  setUserApiKeys(current.filter(k => k !== trimmed));
  window.dispatchEvent(
    new CustomEvent("lostick:toast", {
      detail: { message: "API anahtarı kaldırıldı.", type: "info" }
    })
  );
}

const SESSION_ID_KEY = "lostick.sessionId";

/**
 * Tarayıcı başına kalıcı, anonim oturum kimliği. Çok kullanıcılı dosya izolasyonu
 * için backend'e `X-Session-Id` olarak gönderilir; giriş yapılmamış kullanıcıların
 * yüklediği dosyalar yalnızca kendi oturumlarına ait kalır.
 */
export function getSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  let sid = window.localStorage.getItem(SESSION_ID_KEY);
  if (!sid) {
    sid =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `sid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(SESSION_ID_KEY, sid);
  }
  // Her sohbet odasının yüklenen dosyalarını ve bellek havuzunu backend tarafında izole etmek için aktif sohbet ID'sini ekliyoruz
  const activeChatId = window.localStorage.getItem("lostick.activeChatId") || "chat_1";
  return `${sid}_chat_${activeChatId}`;
}

/** Path bir auth endpoint'i mi? Refresh ve login'de auto-refresh tetiklenmemeli. */
function _isAuthEndpoint(path: string): boolean {
  return (
    path.includes("/api/auth/login") ||
    path.includes("/api/auth/register") ||
    path.includes("/api/auth/refresh") ||
    path.includes("/api/auth/oauth/")
  );
}

/**
 * fetch sarmalayıcısı:
 * - X-User-Api-Key header'ı (key varsa) otomatik eklenir
 * - Authorization: Bearer <access_token> otomatik eklenir
 * - 401 + token vardı → tek seferlik /api/auth/refresh dener, başarılıysa retry'lar
 * - 429 quota hatası geldiğinde özel bir event yayar ki UI ApiKeyDialog açabilsin
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  const buildHeaders = (accessToken: string | null): Headers => {
    const h = new Headers(init?.headers ?? {});
    const userKey = getUserApiKey();
    if (userKey) h.set("X-User-Api-Key", userKey);
    if (accessToken) h.set("Authorization", `Bearer ${accessToken}`);
    if (typeof window !== "undefined") {
      h.set("X-Session-Id", getSessionId());
    }
    return h;
  };

  const readToken = (): string | null => {
    if (typeof window === "undefined") return null;
    const t = window.localStorage.getItem("lostick.authToken");
    return t && t.trim() ? t : null;
  };

  const initialToken = readToken();
  let response = await fetch(url, { ...init, headers: buildHeaders(initialToken) });

  // 401 + token vardı + auth endpoint'i değil → refresh + retry
  if (
    response.status === 401 &&
    initialToken &&
    !_isAuthEndpoint(path) &&
    typeof window !== "undefined"
  ) {
    // Lazy import: circular dep'i çalışma zamanına çek
    const { refreshAccessToken } = await import("./auth");
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await fetch(url, { ...init, headers: buildHeaders(newToken) });
    }
  }

  if (response.status === 429 && typeof window !== "undefined") {
    // Quota event'i: dinleyen herhangi bir component ApiKeyDialog'u açabilir
    let detail = "Günlük istek limiti doldu.";
    try {
      const data = await response.clone().json();
      detail = data.detail ?? detail;
    } catch {
      /* json parse hata verebilir, görmezden gel */
    }
    window.dispatchEvent(
      new CustomEvent("lostick:quota-exceeded", { detail }),
    );
    window.dispatchEvent(
      new CustomEvent("lostick:toast", {
        detail: { message: detail, type: "error" }
      })
    );
  }
  return response;
}

export interface ApiKeyStatus {
  key?: string;
  masked: string;
  status: 'active' | 'cooldown' | 'exhausted';
  cooldown_until: number;
  daily_count: number;
}

export interface ApiKeysStatusResponse {
  status: string;
  server_keys: ApiKeyStatus[];
  user_keys: ApiKeyStatus[];
}

export async function fetchKeysStatus(): Promise<ApiKeysStatusResponse | null> {
  try {
    const userKeys = getUserApiKeys();
    const res = await apiFetch("/api/keys/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keys: userKeys }),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error("Error fetching keys status:", e);
  }
  return null;
}

