/**
 * Flashcard export — kayıtlı kart destelerini PDF / DOCX / JSON olarak indirme.
 *
 * Her kart için: Soru + Betimlemeli mod (tanım + benzetme) + Spot mod (maddeler) yazılır.
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
import type { SavedFlashcardSet } from "./savedFlashcards";

// pdfmake vfs ayarı
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

function safeFilename(s: SavedFlashcardSet, extension: string): string {
  const base = s.pdfName.replace(/\.pdf$/i, "");
  const stamp = new Date(s.createdAt).toISOString().slice(0, 10);
  const cleaned = base
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${cleaned}_${s.count}kart_${stamp}.${extension}`;
}

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

// ─── JSON ─────────────────────────────────────────────────────────────
export function exportFlashcardsAsJSON(s: SavedFlashcardSet): void {
  const payload = {
    pdfName: s.pdfName,
    createdAt: new Date(s.createdAt).toISOString(),
    count: s.count,
    cards: s.cards.map((c, i) => ({
      index: i + 1,
      question: c.soru,
      descriptive: { definition: c.tanim, analogy: c.betimleme },
      spot: c.spot,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  triggerDownload(blob, safeFilename(s, "json"));
}

// ─── PDF (pdfmake) ────────────────────────────────────────────────────
export function exportFlashcardsAsPDF(s: SavedFlashcardSet): void {
  const content: Content[] = [];

  content.push({ text: "Lostick AI · Öğrenme Kartları", style: "title" });
  content.push({
    text: `Belge: ${s.pdfName.replace(/\.pdf$/i, "")}   ·   Kart: ${s.count}   ·   Tarih: ${new Date(s.createdAt).toLocaleDateString("tr-TR")}`,
    style: "meta",
  });
  content.push({
    canvas: [
      { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#cccccc" },
    ],
    margin: [0, 6, 0, 12],
  });

  s.cards.forEach((c, idx) => {
    content.push({
      text: [
        { text: `Kart ${idx + 1}.  `, bold: true, fontSize: 12 },
        { text: c.soru, bold: true, fontSize: 12 },
      ],
      margin: [0, 10, 0, 4],
    });

    // Betimlemeli mod
    content.push({ text: "Betimlemeli Mod", style: "modeLabel" });
    content.push({ text: c.tanim, style: "body", margin: [12, 0, 0, 3] });
    if (c.betimleme) {
      content.push({
        text: [
          { text: "Betimleme: ", italics: true, bold: true, color: "#B36E00" },
          { text: c.betimleme, italics: true, color: "#555555" },
        ],
        margin: [12, 0, 0, 4],
        fontSize: 10,
      });
    }

    // Spot mod
    if (c.spot.length > 0) {
      content.push({ text: "Spot Mod", style: "modeLabel" });
      content.push({
        ul: c.spot.map((b) => ({ text: b })),
        margin: [12, 0, 0, 4],
        fontSize: 10,
      });
    }

    content.push({
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.3, lineColor: "#eeeeee" },
      ],
      margin: [0, 6, 0, 0],
    });
  });

  const styles: StyleDictionary = {
    title: { fontSize: 20, bold: true, margin: [0, 0, 0, 6] },
    meta: { fontSize: 10, color: "#707070", margin: [0, 0, 0, 4] },
    modeLabel: {
      fontSize: 9,
      bold: true,
      color: "#B36E00",
      margin: [8, 4, 0, 2],
    },
    body: { fontSize: 11, margin: [0, 0, 0, 4] },
  };

  const docDef: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [48, 56, 48, 56],
    content,
    defaultStyle: { font: "Roboto", fontSize: 11 },
    styles,
  };

  pdfMake.createPdf(docDef).download(safeFilename(s, "pdf"));
}

// ─── DOCX ─────────────────────────────────────────────────────────────
export async function exportFlashcardsAsDOCX(s: SavedFlashcardSet): Promise<void> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: "Lostick AI · Öğrenme Kartları", bold: true })],
    }),
  );
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `Belge: ${s.pdfName.replace(/\.pdf$/i, "")}    Kart: ${s.count}    Tarih: ${new Date(s.createdAt).toLocaleDateString("tr-TR")}`,
          size: 18,
          color: "707070",
        }),
      ],
    }),
  );

  s.cards.forEach((c, idx) => {
    children.push(
      new Paragraph({
        spacing: { before: 220, after: 60 },
        children: [
          new TextRun({ text: `Kart ${idx + 1}. `, bold: true, size: 24 }),
          new TextRun({ text: c.soru, bold: true, size: 24 }),
        ],
      }),
    );

    children.push(
      new Paragraph({
        spacing: { before: 60, after: 30 },
        children: [new TextRun({ text: "Betimlemeli Mod", bold: true, color: "B36E00", size: 18 })],
      }),
    );
    children.push(
      new Paragraph({
        indent: { left: 360 },
        spacing: { after: 40 },
        children: [new TextRun({ text: c.tanim, size: 22 })],
      }),
    );
    if (c.betimleme) {
      children.push(
        new Paragraph({
          indent: { left: 360 },
          spacing: { after: 60 },
          children: [
            new TextRun({ text: "Betimleme: ", italics: true, bold: true, color: "B36E00", size: 20 }),
            new TextRun({ text: c.betimleme, italics: true, color: "555555", size: 20 }),
          ],
        }),
      );
    }

    if (c.spot.length > 0) {
      children.push(
        new Paragraph({
          spacing: { before: 40, after: 30 },
          children: [new TextRun({ text: "Spot Mod", bold: true, color: "B36E00", size: 18 })],
        }),
      );
      for (const b of c.spot) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 30 },
            children: [new TextRun({ text: b, size: 22 })],
          }),
        );
      }
    }
  });

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, safeFilename(s, "docx"));
}
