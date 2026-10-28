/**
 * Kavram Kütüphanesi API client.
 *
 * Tüm veriler backend veritabanında kullanıcıya özel saklanır; bu yüzden işlemler
 * giriş gerektirir. `apiFetch` Authorization header'ını otomatik ekler.
 */

import { apiFetch } from "./apiKey";

export interface KavramKlasor {
  id: number;
  ad: string;
  created_at: number;
  kart_sayisi: number;
}

export interface KavramKart {
  id: number;
  kavram: string;
  tanim: string;
  created_at: number;
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json();
    if (typeof j.detail === "string") return j.detail;
  } catch {
    /* ignore */
  }
  return fallback;
}

export async function listFolders(): Promise<KavramKlasor[]> {
  const res = await apiFetch("/api/kavram/klasorler");
  if (!res.ok) throw new Error(await parseError(res, "Klasörler yüklenemedi."));
  const data = await res.json();
  return Array.isArray(data.klasorler) ? data.klasorler : [];
}

export async function createFolder(ad: string): Promise<KavramKlasor> {
  const res = await apiFetch("/api/kavram/klasor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ad }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Klasör oluşturulamadı."));
  const data = await res.json();
  return data.klasor;
}

export async function deleteFolder(id: number): Promise<void> {
  const res = await apiFetch(`/api/kavram/klasor/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res, "Klasör silinemedi."));
}

export async function listCards(folderId: number): Promise<KavramKart[]> {
  const res = await apiFetch(`/api/kavram/klasor/${folderId}/kartlar`);
  if (!res.ok) throw new Error(await parseError(res, "Kartlar yüklenemedi."));
  const data = await res.json();
  return Array.isArray(data.kartlar) ? data.kartlar : [];
}

export type AddConceptResult =
  | { gecerli: true; kart: KavramKart }
  | { gecerli: false; mesaj: string };

export async function addConcept(
  folderId: number,
  kavram: string,
): Promise<AddConceptResult> {
  const res = await apiFetch(`/api/kavram/klasor/${folderId}/kart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kavram }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Kavram eklenemedi."));
  const data = await res.json();
  if (data.gecerli === false) {
    return { gecerli: false, mesaj: data.mesaj ?? "Bu bir kavram değil." };
  }
  return { gecerli: true, kart: data.kart };
}

export async function deleteCard(cardId: number): Promise<void> {
  const res = await apiFetch(`/api/kavram/kart/${cardId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res, "Kart silinemedi."));
}
