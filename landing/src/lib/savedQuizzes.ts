/**
 * Saved quizzes — localStorage tabanlı, kullanıcıya scope'lu kalıcı soru kümeleri.
 *
 * - Tüm kayıtlar `lostick.savedQuizzes` anahtarında JSON dizisi olarak tutulur
 * - Her kayıt `userId` taşır; UI yalnızca aktif kullanıcının (veya anonim/null) kayıtlarını gösterir
 * - Değişiklikler `lostick:saved-quizzes-changed` event'i ile aynı sekme içinde yayılır
 */

import type { QuizQuestion } from "@/components/chat/QuizView";

export type Zorluk = "Kolay" | "Orta" | "Zor";
export type SoruTipi = "klasik" | "karma";

export interface SavedQuiz {
  id: string;
  createdAt: number;
  userId: number | null;
  pdfName: string;
  count: number;
  difficulty: Zorluk;
  // Eski kayıtlarda bu alanlar yok — UI render ederken yokluk durumunu tolere etmeli
  sikSayisi?: number;
  soruTipi?: SoruTipi;
  questions: QuizQuestion[];
}

const STORAGE_KEY = "lostick.savedQuizzes";
const CHANGE_EVENT = "lostick:saved-quizzes-changed";
const MAX_ENTRIES_PER_USER = 50;

function readAll(): SavedQuiz[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedQuiz[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SavedQuiz[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Bir kullanıcıya ait kayıtları en yeni → en eski sırada döndür. */
export function getSavedQuizzes(userId: number | null): SavedQuiz[] {
  return readAll()
    .filter((q) => (q.userId ?? null) === (userId ?? null))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface SaveQuizInput {
  userId: number | null;
  pdfName: string;
  count: number;
  difficulty: Zorluk;
  sikSayisi?: number;
  soruTipi?: SoruTipi;
  questions: QuizQuestion[];
}

/** Yeni bir soru kümesini kaydeder, üretilen kayıt nesnesini döndürür. */
export function saveQuiz(input: SaveQuizInput): SavedQuiz {
  const entry: SavedQuiz = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `quiz_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    userId: input.userId,
    pdfName: input.pdfName,
    count: input.count,
    difficulty: input.difficulty,
    sikSayisi: input.sikSayisi,
    soruTipi: input.soruTipi,
    questions: input.questions,
  };

  const all = readAll();
  all.push(entry);

  // Kullanıcı başına kayıt sayısını sınırla (en eskiyi sil) — localStorage taşmasın
  const sameUser = all.filter((q) => (q.userId ?? null) === (input.userId ?? null));
  if (sameUser.length > MAX_ENTRIES_PER_USER) {
    sameUser.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sameUser.slice(0, sameUser.length - MAX_ENTRIES_PER_USER);
    const removeIds = new Set(toRemove.map((q) => q.id));
    const trimmed = all.filter((q) => !removeIds.has(q.id));
    writeAll(trimmed);
  } else {
    writeAll(all);
  }

  return entry;
}

export function deleteSavedQuiz(id: string): void {
  const all = readAll();
  const next = all.filter((q) => q.id !== id);
  if (next.length !== all.length) {
    writeAll(next);
  }
}
