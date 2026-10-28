/**
 * Saved flashcards — localStorage tabanlı, kullanıcıya scope'lu kalıcı kart desteleri.
 *
 * - Tüm kayıtlar `lostick.savedFlashcards` anahtarında JSON dizisi olarak tutulur
 * - Her kayıt `userId` taşır; UI yalnızca aktif kullanıcının (veya anonim/null) kayıtlarını gösterir
 * - Değişiklikler `lostick:saved-flashcards-changed` event'i ile aynı sekme içinde yayılır
 */

export interface Flashcard {
  soru: string;
  tanim: string;      // betimlemeli mod — aşama 1: net teknik tanım
  betimleme: string;  // betimlemeli mod — aşama 2: analoji/benzetme
  spot: string[];     // spot mod — 2-3 vurucu madde
}

export interface SavedFlashcardSet {
  id: string;
  createdAt: number;
  userId: number | null;
  pdfName: string;   // "x +N dosya" formatı çoklu dosyada
  count: number;
  cards: Flashcard[];
}

const STORAGE_KEY = "lostick.savedFlashcards";
const CHANGE_EVENT = "lostick:saved-flashcards-changed";
const MAX_ENTRIES_PER_USER = 50;

function readAll(): SavedFlashcardSet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedFlashcardSet[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SavedFlashcardSet[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getSavedFlashcards(userId: number | null): SavedFlashcardSet[] {
  return readAll()
    .filter((s) => (s.userId ?? null) === (userId ?? null))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface SaveFlashcardsInput {
  userId: number | null;
  pdfName: string;
  count: number;
  cards: Flashcard[];
}

export function saveFlashcards(input: SaveFlashcardsInput): SavedFlashcardSet {
  const entry: SavedFlashcardSet = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `cards_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    userId: input.userId,
    pdfName: input.pdfName,
    count: input.count,
    cards: input.cards,
  };

  const all = readAll();
  all.push(entry);

  const sameUser = all.filter((s) => (s.userId ?? null) === (input.userId ?? null));
  if (sameUser.length > MAX_ENTRIES_PER_USER) {
    sameUser.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sameUser.slice(0, sameUser.length - MAX_ENTRIES_PER_USER);
    const removeIds = new Set(toRemove.map((s) => s.id));
    const trimmed = all.filter((s) => !removeIds.has(s.id));
    writeAll(trimmed);
  } else {
    writeAll(all);
  }

  return entry;
}

export function deleteSavedFlashcards(id: string): void {
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length !== all.length) {
    writeAll(next);
  }
}
