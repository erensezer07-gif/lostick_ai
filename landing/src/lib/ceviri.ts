/**
 * Akıllı Doküman Çevirisi API client.
 *
 * Tüm istekler oturuma scope'ludur (apiFetch X-Session-Id + Authorization gönderir).
 * Çeviri arka planda çalışır; job_id ile polling yapılır, bitince PDF indirilir.
 */

import { apiFetch } from "./apiKey";

export interface CeviriDurum {
  status: "running" | "done" | "error" | "cancelled";
  progress: number;
  total: number;
  filename: string | null;
  error: string | null;
  uyari?: string | null;
  hazir: boolean;
}

async function parseDetail(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json();
    if (typeof j.detail === "string") return j.detail;
  } catch {
    /* ignore */
  }
  return fallback;
}

export async function startTranslation(file: File, targetLang: string = "tr", glossary: string = ""): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("target_lang", targetLang);
  fd.append("glossary", glossary);
  const res = await apiFetch("/api/v1/dokuman-cevir", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await parseDetail(res, "Çeviri başlatılamadı."));
  const data = await res.json();
  if (!data.job_id) throw new Error("Çeviri başlatılamadı.");
  return data.job_id as string;
}

export async function getTranslationStatus(jobId: string): Promise<CeviriDurum> {
  const res = await apiFetch(`/api/v1/ceviri-durum/${jobId}`);
  if (res.status === 404) throw new Error("404");
  if (!res.ok) throw new Error(await parseDetail(res, "Durum alınamadı."));
  return (await res.json()) as CeviriDurum;
}

export async function downloadTranslation(jobId: string, filename: string): Promise<void> {
  const res = await apiFetch(`/api/v1/ceviri-indir/${jobId}`);
  if (!res.ok) throw new Error(await parseDetail(res, "İndirme başarısız."));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "ceviri-TR.pdf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function cancelTranslation(jobId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/ceviri-iptal/${jobId}`, { method: "POST" });
  } catch {
    /* client tarafı yine de temizlenir */
  }
}
