"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type QuestionType = "coktan_secmeli" | "bosluk_doldurma" | "dogru_yanlis";

export interface QuizQuestion {
  soru: string;
  A: string;
  B: string;
  C?: string;
  D?: string;
  E?: string;
  dogru_cevap: string;
  aciklama: string;
  /** Eski (legacy) testler bu alanı içermeyebilir — yoksa "coktan_secmeli" varsay. */
  soru_tipi?: QuestionType;
}

type AnswerKey = "A" | "B" | "C" | "D" | "E";

const ALL_OPTIONS: AnswerKey[] = ["A", "B", "C", "D", "E"];

/** Bir soru için aktif şıkları (dolu olanları) sırasıyla döndürür. */
function getOptionsForQuestion(q: QuizQuestion): AnswerKey[] {
  return ALL_OPTIONS.filter((k) => typeof q[k] === "string" && (q[k] as string).length > 0);
}

function getQuestionType(q: QuizQuestion): QuestionType {
  return q.soru_tipi ?? "coktan_secmeli";
}

interface QuestionState {
  answer: AnswerKey | null;
  marked: boolean;
}

type QuestionStatus = "current" | "correct" | "wrong" | "marked" | "empty";

interface QuizViewProps {
  quiz: QuizQuestion[];
  onExit: () => void;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getCorrect(q: QuizQuestion): AnswerKey {
  return ((q.dogru_cevap ?? "").trim().toUpperCase() as AnswerKey) || "A";
}

export default function QuizView({ quiz, onExit }: QuizViewProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [states, setStates] = useState<Record<number, QuestionState>>({});
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isFinished, setIsFinished] = useState(false);

  const explanationRef = useRef<HTMLDivElement>(null);
  const scrolledIndexes = useRef<Set<number>>(new Set());

  const question = quiz[currentIndex];
  const total = quiz.length;
  const currentState = states[currentIndex] ?? { answer: null, marked: false };
  const currentAnswer = currentState.answer;
  const correctAnswer = getCorrect(question);
  const isAnswered = currentAnswer !== null;
  const currentOptions = getOptionsForQuestion(question);
  const currentType = getQuestionType(question);

  // Geçen süre sayacı — sınav bittiğinde durur
  useEffect(() => {
    if (isFinished) return;
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isFinished]);

  // Cevap verildiğinde açıklamaya kaydır (sadece ilk cevaplama anında)
  useEffect(() => {
    if (currentAnswer && !scrolledIndexes.current.has(currentIndex)) {
      scrolledIndexes.current.add(currentIndex);
      setTimeout(() => {
        explanationRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 400);
    }
  }, [currentAnswer, currentIndex]);

  function updateState(index: number, patch: Partial<QuestionState>) {
    setStates((prev) => ({
      ...prev,
      [index]: {
        ...(prev[index] ?? { answer: null, marked: false }),
        ...patch,
      },
    }));
  }

  function handleSelect(option: AnswerKey) {
    if (isAnswered) return; // cevap kilitli — değiştirilemez
    updateState(currentIndex, { answer: option });
  }

  function handleToggleMark() {
    updateState(currentIndex, { marked: !currentState.marked });
  }

  function handleGoTo(index: number) {
    if (index < 0 || index >= total) return;
    setCurrentIndex(index);
  }

  function handleNext() {
    if (currentIndex + 1 >= total) {
      setIsFinished(true);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  }

  function handleRestart() {
    setCurrentIndex(0);
    setStates({});
    setElapsedSeconds(0);
    setIsFinished(false);
    scrolledIndexes.current.clear();
  }

  function getQuestionStatus(index: number): QuestionStatus {
    if (index === currentIndex) return "current";
    const s = states[index];
    if (s?.answer) {
      const correct = getCorrect(quiz[index]);
      return s.answer === correct ? "correct" : "wrong";
    }
    if (s?.marked) return "marked";
    return "empty";
  }

  const correctCount = useMemo(() => {
    return quiz.reduce((acc, q, idx) => {
      const userAnswer = states[idx]?.answer;
      if (userAnswer && userAnswer === getCorrect(q)) return acc + 1;
      return acc;
    }, 0);
  }, [quiz, states]);

  const answeredCount = Object.values(states).filter((s) => s.answer).length;

  // -- Sonuç ekranı --
  if (isFinished) {
    const percent = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    const passed = percent >= 60;

    return (
      <div className="flex flex-col h-full bg-background">
        <header className="w-full px-margin-mobile md:px-margin-desktop py-3 flex items-center justify-between border-b border-surface-variant/50 flex-shrink-0">
          <button
            type="button"
            onClick={onExit}
            className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors group"
          >
            <span
              className="material-symbols-outlined transition-transform group-hover:-translate-x-1"
              style={{ fontSize: 20 }}
            >
              arrow_back
            </span>
            <span className="font-mono text-label-sm uppercase tracking-wider font-semibold">
              Geri
            </span>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-primary-container" />
            <h1 className="font-headline font-semibold text-on-surface">
              Sınav Sonucu
            </h1>
          </div>
          <div className="font-mono text-label-sm text-on-surface-variant">
            Süre:{" "}
            <span className="text-on-surface font-semibold tabular-nums">
              {formatElapsed(elapsedSeconds)}
            </span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-margin-mobile md:px-margin-desktop py-lg flex flex-col items-center text-center gap-md">
            <div className="w-20 h-20 rounded-lg border border-surface-variant bg-surface-container-low flex items-center justify-center">
              <span
                className={`material-symbols-outlined ${
                  passed ? "text-primary-container" : "text-on-surface-variant"
                }`}
                style={{ fontSize: 48 }}
              >
                {passed ? "workspace_premium" : "fact_check"}
              </span>
            </div>

            <div>
              <h2 className="font-headline text-headline-lg-mobile md:text-headline-lg text-on-surface mb-2">
                Testi Tamamladın
              </h2>
              <p className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
                {passed ? "Tebrikler · Geçtin" : "Çalışmaya Devam"}
              </p>
            </div>

            <div className="w-full max-w-md bg-surface-container-low border border-surface-variant rounded-xl p-md">
              <div className="flex items-baseline justify-between mb-md">
                <span className="font-mono text-label-sm text-on-surface-variant uppercase tracking-wider">
                  Skor
                </span>
                <span className="font-display text-4xl font-extrabold text-primary-container leading-none">
                  {correctCount}
                  <span className="text-2xl text-on-surface-variant/60">
                    /{total}
                  </span>
                </span>
              </div>

              <div className="h-1.5 bg-surface-variant rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-gradient-to-r from-primary-container to-primary rounded-full transition-all duration-700"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="flex justify-between font-mono text-label-sm text-on-surface-variant">
                <span>%{percent} başarı</span>
                <span>{total - correctCount} yanlış</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-sm justify-center pt-sm">
              <button
                type="button"
                onClick={handleRestart}
                className="border border-surface-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-6 py-3 rounded-lg transition-all flex items-center gap-2"
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 18 }}
                >
                  restart_alt
                </span>
                Yeniden Başla
              </button>
              <button
                type="button"
                onClick={onExit}
                className="bg-primary-container text-on-primary-container font-mono text-label-sm px-6 py-3 rounded-lg hover:bg-primary transition-all font-bold flex items-center gap-2"
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 18 }}
                >
                  home
                </span>
                Ana Sayfa
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // -- Soru ekranı --
  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header — kompakt */}
      <header className="w-full px-margin-mobile md:px-margin-desktop py-3 flex items-center justify-between border-b border-surface-variant/50 flex-shrink-0">
        <button
          type="button"
          onClick={onExit}
          aria-label="Ana sayfaya dön"
          className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors group"
        >
          <span
            className="material-symbols-outlined transition-transform group-hover:-translate-x-1"
            style={{ fontSize: 20 }}
          >
            arrow_back
          </span>
          <span className="font-mono text-label-sm uppercase tracking-wider font-semibold hidden sm:inline">
            Geri
          </span>
        </button>

        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2.5 h-2.5 rounded-full bg-primary-container shadow-[0_0_15px_rgba(255,193,7,0.4)] animate-pulse-gold flex-shrink-0" />
          <h1 className="font-headline font-semibold text-on-surface tracking-wide truncate">
            Sınav Modu
          </h1>
        </div>

        <div className="font-mono text-label-sm text-on-surface-variant flex-shrink-0">
          <span className="hidden sm:inline">Geçen Süre: </span>
          <span className="text-on-surface font-semibold tabular-nums">
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
      </header>

      {/* Main — scrollable */}
      <main className="flex-1 overflow-y-auto">
        <div className="flex items-start justify-center px-margin-mobile md:px-margin-desktop py-3 lg:gap-md w-full max-w-7xl mx-auto">
          {/* Sol sütun */}
          <div className="flex-1 w-full max-w-3xl flex flex-col gap-3">
            {/* Soru kartı */}
            <section className="bg-surface-container-low border border-surface-variant rounded-xl p-4 md:p-5 shadow-lg relative overflow-hidden">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-20 bg-primary-container/5 blur-3xl rounded-full pointer-events-none" />
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="inline-flex items-center justify-center bg-primary-container text-on-primary-container font-bold text-xs px-3 py-1.5 rounded-md uppercase tracking-wider">
                      Soru {currentIndex + 1}
                    </div>
                    {currentType !== "coktan_secmeli" && (
                      <div
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border font-mono text-[10px] uppercase tracking-wider ${
                          currentType === "bosluk_doldurma"
                            ? "bg-purple-500/15 border-purple-500/40 text-purple-300"
                            : "bg-sky-500/15 border-sky-500/40 text-sky-300"
                        }`}
                      >
                        <span
                          className="material-symbols-outlined"
                          style={{ fontSize: 13 }}
                        >
                          {currentType === "bosluk_doldurma" ? "edit_note" : "rule"}
                        </span>
                        {currentType === "bosluk_doldurma"
                          ? "Boşluk Doldurma"
                          : "Doğru / Yanlış"}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleMark}
                    aria-pressed={currentState.marked}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border font-mono text-xs uppercase tracking-wider transition-colors ${
                      currentState.marked
                        ? "bg-orange-500/15 border-orange-500/50 text-orange-300 hover:bg-orange-500/20"
                        : "bg-surface-container border-surface-variant text-on-surface-variant hover:text-on-surface hover:border-on-surface-variant/50"
                    }`}
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 15 }}
                    >
                      {currentState.marked ? "bookmark" : "bookmark_border"}
                    </span>
                    {currentState.marked ? "İşaretli" : "İşaretle"}
                  </button>
                </div>
                <h2 className="font-headline text-lg md:text-xl font-semibold text-on-surface leading-snug [overflow-wrap:anywhere]">
                  {question.soru}
                </h2>
              </div>
            </section>

            {/* Şıklar */}
            <section
              aria-label="Cevap Seçenekleri"
              className="flex flex-col gap-2"
            >
              {currentOptions.map((opt) => {
                const isSelected = currentAnswer === opt;
                const isCorrect = opt === correctAnswer;
                const showAsCorrect = isAnswered && isCorrect;
                const showAsWrong = isAnswered && isSelected && !isCorrect;
                const isInactive =
                  isAnswered && !isSelected && !isCorrect;

                let stateClasses =
                  "border-surface-variant bg-surface-container-low/60 hover:bg-surface-container-low hover:border-on-surface-variant/40 cursor-pointer";
                let badgeClasses =
                  "bg-surface-container-high text-on-surface-variant group-hover:text-on-surface";
                let textClasses =
                  "text-on-surface-variant group-hover:text-on-surface";

                if (showAsCorrect) {
                  stateClasses =
                    "border-emerald-500/70 bg-emerald-950/40 shadow-[0_0_18px_rgba(16,185,129,0.2)]";
                  badgeClasses =
                    "bg-emerald-500/25 text-emerald-200 border border-emerald-500/50";
                  textClasses = "text-emerald-100 font-medium";
                } else if (showAsWrong) {
                  stateClasses =
                    "border-red-500/80 bg-red-950/50 shadow-[0_0_20px_rgba(220,38,38,0.35)]";
                  badgeClasses =
                    "bg-red-500/30 text-red-200 border border-red-500/60";
                  textClasses = "text-red-200 font-medium";
                } else if (isInactive) {
                  stateClasses =
                    "border-surface-variant/40 bg-surface-container-low/30 cursor-default";
                  badgeClasses =
                    "bg-surface-container text-on-surface-variant/40";
                  textClasses = "text-on-surface-variant/40";
                } else if (isSelected) {
                  stateClasses =
                    "border-primary-container bg-surface-container-low";
                  badgeClasses =
                    "bg-surface-container-high text-primary-container border border-primary-container/30";
                  textClasses = "text-on-surface font-medium";
                }

                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => handleSelect(opt)}
                    disabled={isAnswered}
                    className={`group flex items-center gap-3 p-3 md:p-3.5 rounded-lg border text-left transition-all duration-200 disabled:cursor-default ${stateClasses}`}
                  >
                    <div
                      className={`flex items-center justify-center w-9 h-9 rounded font-bold flex-shrink-0 text-base transition-colors ${badgeClasses}`}
                    >
                      {opt}
                    </div>
                    <span
                      className={`text-base md:text-lg leading-snug flex-1 [overflow-wrap:anywhere] ${textClasses}`}
                    >
                      {question[opt] ?? ""}
                    </span>
                    {showAsCorrect && (
                      <span
                        className="material-symbols-outlined text-emerald-300 flex-shrink-0"
                        style={{ fontSize: 20 }}
                      >
                        check_circle
                      </span>
                    )}
                    {showAsWrong && (
                      <span
                        className="material-symbols-outlined text-red-400 flex-shrink-0"
                        style={{ fontSize: 20 }}
                      >
                        cancel
                      </span>
                    )}
                  </button>
                );
              })}
            </section>

            {/* Açıklama — cevap verildikten sonra animasyonla açılır */}
            <div
              ref={explanationRef}
              className={`grid transition-all duration-500 ease-out ${
                isAnswered
                  ? "grid-rows-[1fr] opacity-100 mt-1"
                  : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <div className="bg-surface-container-low border border-primary-container/30 rounded-xl p-3 md:p-4 flex gap-3 items-start">
                  <div className="w-9 h-9 rounded-lg bg-surface-container-highest border border-outline-variant/40 flex items-center justify-center flex-shrink-0">
                    <span
                      className="material-symbols-outlined text-primary-container"
                      style={{ fontSize: 18 }}
                    >
                      lightbulb
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest mb-1">
                      AI Analizi
                    </p>
                    <p className="font-body text-sm md:text-base text-on-surface leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {question.aciklama}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sağ sütun: Soru haritası */}
          <aside className="hidden lg:block w-72 shrink-0">
            <div className="bg-surface-container-low border border-surface-variant rounded-xl p-3 md:p-4 shadow-xl sticky top-3">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="font-headline font-semibold text-on-surface text-sm">
                  Soru Haritası
                </h3>
                <span className="font-mono text-label-sm text-on-surface-variant">
                  {answeredCount}/{total}
                </span>
              </div>
              <div
                className="grid grid-cols-5 gap-1.5"
                aria-label="Soru Haritası"
              >
                {quiz.map((_, idx) => {
                  const status = getQuestionStatus(idx);
                  let cls =
                    "bg-surface-variant text-on-surface-variant hover:bg-surface-container-high font-semibold";
                  if (status === "current") {
                    cls =
                      "bg-primary-container text-on-primary-container shadow-[0_0_12px_rgba(255,193,7,0.45)] font-bold";
                  } else if (status === "correct") {
                    cls =
                      "bg-emerald-600 text-white font-semibold hover:opacity-90";
                  } else if (status === "wrong") {
                    cls =
                      "bg-red-600 text-white font-semibold hover:bg-red-500";
                  } else if (status === "marked") {
                    cls =
                      "bg-orange-500 text-white font-semibold hover:opacity-90";
                  }
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleGoTo(idx)}
                      aria-current={status === "current" ? "true" : undefined}
                      aria-label={`Soru ${idx + 1}, ${
                        status === "current"
                          ? "mevcut"
                          : status === "correct"
                            ? "doğru"
                            : status === "wrong"
                              ? "yanlış"
                              : status === "marked"
                                ? "işaretli"
                                : "boş"
                      }`}
                      className={`w-9 h-9 rounded-md text-sm flex items-center justify-center transition-all hover:scale-105 ${cls}`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="mt-3 pt-3 border-t border-surface-variant space-y-1">
                <LegendItem color="bg-primary-container" label="Mevcut" />
                <LegendItem color="bg-emerald-600" label="Doğru" />
                <LegendItem color="bg-red-600" label="Yanlış" />
                <LegendItem color="bg-orange-500" label="İşaretli" />
                <LegendItem color="bg-surface-variant" label="Boş" />
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full px-margin-mobile md:px-margin-desktop py-3 border-t border-surface-variant/50 bg-surface/95 backdrop-blur-sm flex-shrink-0">
        <div className="max-w-7xl w-full mx-auto flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => handleGoTo(currentIndex - 1)}
            disabled={currentIndex === 0}
            className="flex items-center gap-1.5 font-mono text-label-sm uppercase tracking-wider text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 18 }}
            >
              arrow_back
            </span>
            <span className="hidden sm:inline">Önceki</span>
          </button>
          <button
            type="button"
            onClick={handleNext}
            className="flex items-center justify-center gap-2 bg-primary-container hover:bg-primary text-on-primary-container font-bold py-2.5 px-5 md:py-3 md:px-6 rounded-xl shadow-[0_0_25px_rgba(255,193,7,0.35)] transition-all duration-300 hover:scale-[1.03] active:scale-95"
          >
            {currentIndex + 1 >= total ? "Sonucu Gör" : "Sonraki Soru"}
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 20 }}
            >
              arrow_forward
            </span>
          </button>
        </div>
      </footer>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-3 h-3 rounded ${color}`} />
      <span className="font-mono text-label-sm text-on-surface-variant">
        {label}
      </span>
    </div>
  );
}
