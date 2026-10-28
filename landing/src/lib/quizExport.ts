/**
 * Quiz export — kayıtlı testleri PDF / JSON / DOCX olarak indirme.
 *
 * - PDF: pdfmake ile üretilir; Roboto fontu Latin-Extended (Türkçe) destekli olduğu için
 *   "ş, ğ, ı, ö, ü, ç" gibi karakterler doğru render edilir. jsPDF'in Helvetica fontu
 *   bunları desteklemediğinden bu kütüphaneye geçildi.
 * - JSON: tarayıcı native — `Blob` + `URL.createObjectURL`, Anki/Kahoot vs. için ham veri
 * - DOCX: docx kütüphanesi ile, öğretmenin Word'de düzenlemesi için
 */

import pdfMake from "pdfmake/build/pdfmake";
import * as pdfFontsModule from "pdfmake/build/vfs_fonts";
import type {
  Content,
  TDocumentDefinitions,
  StyleDictionary,
} from "pdfmake/interfaces";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from "docx";
import type { SavedQuiz } from "./savedQuizzes";

// pdfmake vfs ayarı: paket versiyonuna göre default vfs ya doğrudan, ya da pdfMake.vfs altında olabilir
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _pdfFonts: any = pdfFontsModule;
const _vfs =
  _pdfFonts?.pdfMake?.vfs ??
  _pdfFonts?.vfs ??
  _pdfFonts?.default?.pdfMake?.vfs ??
  _pdfFonts?.default?.vfs;
if (_vfs) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfMake as any).vfs = _vfs;
}

const ALL_OPTIONS: Array<"A" | "B" | "C" | "D" | "E"> = ["A", "B", "C", "D", "E"];

/** Bir soru için dolu olan şıkları sırasıyla döndürür (boş veya undefined olanları atlar). */
function getActiveOptions(
  q: import("./savedQuizzes").SavedQuiz["questions"][number],
): Array<"A" | "B" | "C" | "D" | "E"> {
  return ALL_OPTIONS.filter((k) => {
    const v = (q as unknown as Record<string, unknown>)[k];
    return typeof v === "string" && v.length > 0;
  });
}

/** Soru tipi etiketi (eski testlerde alan yok → "coktan_secmeli" varsay). */
function getQuestionTypeLabel(
  q: import("./savedQuizzes").SavedQuiz["questions"][number],
): string {
  const t = (q as unknown as Record<string, unknown>).soru_tipi as string | undefined;
  if (t === "bosluk_doldurma") return "Boşluk Doldurma";
  if (t === "dogru_yanlis") return "Doğru / Yanlış";
  return "";
}

/** Dosya adı için PDF adından geçersiz karakterleri ayıkla. */
function safeFilename(quiz: SavedQuiz, extension: string): string {
  const base = quiz.pdfName.replace(/\.pdf$/i, "");
  const stamp = new Date(quiz.createdAt).toISOString().slice(0, 10);
  const cleaned = base
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${cleaned}_${quiz.count}soru_${quiz.difficulty}_${stamp}.${extension}`;
}

/** Tarayıcıda bir blob'u indirme olarak başlat. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ─── JSON ────────────────────────────────────────────────────────────
export function exportQuizAsJSON(quiz: SavedQuiz): void {
  const payload = {
    pdfName: quiz.pdfName,
    createdAt: new Date(quiz.createdAt).toISOString(),
    count: quiz.count,
    difficulty: quiz.difficulty,
    questions: quiz.questions.map((q, i) => {
      const opts = getActiveOptions(q);
      const options: Record<string, string> = {};
      for (const k of opts) options[k] = (q as unknown as Record<string, string>)[k];
      const tip =
        ((q as unknown as Record<string, unknown>).soru_tipi as string | undefined) ??
        "coktan_secmeli";
      return {
        index: i + 1,
        type: tip,
        question: q.soru,
        options,
        correctAnswer: (q.dogru_cevap ?? "").trim().toUpperCase(),
        explanation: q.aciklama,
      };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  triggerDownload(blob, safeFilename(quiz, "json"));
}

// ─── PDF (pdfmake) ───────────────────────────────────────────────────
export function exportQuizAsPDF(
  quiz: SavedQuiz,
  includeAnswers: boolean,
): void {
  const content: Content[] = [];

  // Başlık
  content.push({ text: "Lostick AI · Test", style: "title" });

  // Meta satırı
  content.push({
    text: `PDF: ${quiz.pdfName.replace(/\.pdf$/i, "")}   ·   Soru: ${quiz.count}   ·   Zorluk: ${quiz.difficulty}   ·   Tarih: ${new Date(quiz.createdAt).toLocaleDateString("tr-TR")}`,
    style: "meta",
  });

  if (includeAnswers) {
    content.push({
      text: "CEVAP ANAHTARLI SÜRÜM",
      style: "answerBanner",
    });
  }

  // Yatay ayraç
  content.push({
    canvas: [
      { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#cccccc" },
    ],
    margin: [0, 6, 0, 12],
  });

  // Sorular
  quiz.questions.forEach((q, idx) => {
    const typeLabel = getQuestionTypeLabel(q);
    if (typeLabel) {
      content.push({
        text: [
          { text: `Soru ${idx + 1}.`, bold: true, fontSize: 12 },
          {
            text: `   [${typeLabel}]`,
            italics: true,
            color: "#B36E00",
            fontSize: 10,
          },
        ],
        margin: [0, 8, 0, 4],
      });
    } else {
      content.push({ text: `Soru ${idx + 1}.`, style: "soruNo" });
    }
    content.push({ text: q.soru, style: "soruText" });

    const correct = (q.dogru_cevap ?? "").trim().toUpperCase();
    const activeOpts = getActiveOptions(q);
    for (const opt of activeOpts) {
      const isCorrect = includeAnswers && opt === correct;
      const text = (q as unknown as Record<string, string>)[opt] ?? "";
      content.push({
        text: [
          { text: `${opt})  `, bold: isCorrect },
          { text, bold: isCorrect },
          ...(isCorrect ? [{ text: "   ✓", bold: true }] : []),
        ],
        color: isCorrect ? "#0F7544" : "#222222",
        margin: [16, 2, 0, 2],
      });
    }

    if (includeAnswers && q.aciklama) {
      content.push({
        text: `Açıklama: ${q.aciklama}`,
        italics: true,
        color: "#707070",
        fontSize: 9,
        margin: [16, 4, 0, 0],
      });
    }

    // Soru arası boşluk
    content.push({ text: "", margin: [0, 0, 0, 8] });
  });

  // Cevap anahtarı bloğu (cevaplı sürümde sona)
  if (includeAnswers) {
    content.push({
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#cccccc" },
      ],
      margin: [0, 12, 0, 8],
    });
    content.push({ text: "Cevap Anahtarı", style: "soruNo", fontSize: 14 });

    const cols = 5;
    const rows: Content[][] = [];
    for (let r = 0; r < Math.ceil(quiz.questions.length / cols); r++) {
      const row: Content[] = [];
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i < quiz.questions.length) {
          const correct = (quiz.questions[i].dogru_cevap ?? "")
            .trim()
            .toUpperCase();
          row.push({ text: `${i + 1}. ${correct}`, fontSize: 11 });
        } else {
          row.push({ text: "" });
        }
      }
      rows.push(row);
    }

    content.push({
      table: {
        widths: ["20%", "20%", "20%", "20%", "20%"],
        body: rows,
      },
      layout: "noBorders",
      margin: [0, 4, 0, 0],
    });
  }

  const styles: StyleDictionary = {
    title: { fontSize: 20, bold: true, margin: [0, 0, 0, 10] },
    meta: { fontSize: 10, color: "#707070", margin: [0, 0, 0, 4] },
    answerBanner: {
      fontSize: 10,
      bold: true,
      color: "#B36E00",
      margin: [0, 2, 0, 4],
    },
    soruNo: { fontSize: 12, bold: true, margin: [0, 8, 0, 4] },
    soruText: { fontSize: 11, margin: [0, 0, 0, 6] },
  };

  const docDef: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [48, 56, 48, 56],
    content,
    defaultStyle: { font: "Roboto", fontSize: 11 },
    styles,
  };

  pdfMake.createPdf(docDef).download(safeFilename(quiz, "pdf"));
}

// ─── DOCX ────────────────────────────────────────────────────────────
export async function exportQuizAsDOCX(
  quiz: SavedQuiz,
  includeAnswers: boolean,
): Promise<void> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: "Lostick AI · Test", bold: true })],
    }),
  );

  children.push(
    new Paragraph({
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: `PDF: ${quiz.pdfName.replace(/\.pdf$/i, "")}    Soru: ${quiz.count}    Zorluk: ${quiz.difficulty}    Tarih: ${new Date(quiz.createdAt).toLocaleDateString("tr-TR")}`,
          size: 18,
          color: "707070",
        }),
      ],
    }),
  );

  if (includeAnswers) {
    children.push(
      new Paragraph({
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: "CEVAP ANAHTARLI SÜRÜM",
            bold: true,
            color: "B36E00",
            size: 18,
          }),
        ],
      }),
    );
  } else {
    children.push(new Paragraph({ spacing: { after: 240 }, children: [] }));
  }

  quiz.questions.forEach((q, idx) => {
    const typeLabel = getQuestionTypeLabel(q);
    children.push(
      new Paragraph({
        spacing: { before: 200, after: 80 },
        children: [
          new TextRun({ text: `Soru ${idx + 1}.`, bold: true, size: 24 }),
          ...(typeLabel
            ? [
                new TextRun({
                  text: `   [${typeLabel}]`,
                  italics: true,
                  color: "B36E00",
                  size: 20,
                }),
              ]
            : []),
        ],
      }),
    );
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: q.soru, size: 22 })],
      }),
    );

    const correct = (q.dogru_cevap ?? "").trim().toUpperCase();
    const activeOpts = getActiveOptions(q);
    for (const opt of activeOpts) {
      const isCorrect = includeAnswers && opt === correct;
      const text = (q as unknown as Record<string, string>)[opt] ?? "";
      children.push(
        new Paragraph({
          indent: { left: 360 },
          spacing: { after: 60 },
          children: [
            new TextRun({
              text: `${opt})  `,
              bold: isCorrect,
              color: isCorrect ? "146E3C" : undefined,
              size: 22,
            }),
            new TextRun({
              text,
              bold: isCorrect,
              color: isCorrect ? "146E3C" : undefined,
              size: 22,
            }),
            ...(isCorrect
              ? [
                  new TextRun({
                    text: "    ✓",
                    bold: true,
                    color: "146E3C",
                    size: 22,
                  }),
                ]
              : []),
          ],
        }),
      );
    }

    if (includeAnswers && q.aciklama) {
      children.push(
        new Paragraph({
          indent: { left: 360 },
          spacing: { before: 100, after: 100 },
          children: [
            new TextRun({
              text: "Açıklama: ",
              italics: true,
              color: "707070",
              size: 20,
            }),
            new TextRun({
              text: q.aciklama,
              italics: true,
              color: "707070",
              size: 20,
            }),
          ],
        }),
      );
    }
  });

  if (includeAnswers) {
    children.push(
      new Paragraph({
        spacing: { before: 400, after: 120 },
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "Cevap Anahtarı", bold: true })],
      }),
    );
    const line = quiz.questions
      .map((q, i) => `${i + 1}. ${(q.dogru_cevap ?? "").trim().toUpperCase()}`)
      .join("    ");
    children.push(
      new Paragraph({
        children: [new TextRun({ text: line, size: 22 })],
      }),
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, safeFilename(quiz, "docx"));
}
