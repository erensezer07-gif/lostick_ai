/**
 * Anlatım export — kayıtlı konu anlatımlarını PDF / DOCX / JSON olarak indirme.
 *
 * - Markdown'u minimal şekilde parse edip pdfmake/docx yapılarına çeviririz.
 * - Mermaid blokları ve görseller (img/gorsel) export'ta atlanır — placeholder bırakılır.
 *   (Bunlar canlı web görünümünde anlamlı; statik dokümanda render edilemiyor.)
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
  Table,
  TableRow,
  TableCell,
  WidthType,
} from "docx";
import type { SavedAnlatim } from "./savedAnlatim";

// pdfmake vfs ayarı — paket sürümüne göre default vfs farklı yerde olabilir
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

const UZUNLUK_LABEL: Record<SavedAnlatim["uzunluk"], string> = {
  kisa: "Kısa",
  orta: "Orta",
  uzun: "Uzun",
};

const MOD_LABEL: Record<SavedAnlatim["mod"], string> = {
  ogretici: "Öğretici",
  sinav_odakli: "Sınav Odaklı",
};

function safeFilename(a: SavedAnlatim, extension: string): string {
  const base = a.pdfName.replace(/\.pdf$/i, "");
  const stamp = new Date(a.createdAt).toISOString().slice(0, 10);
  const cleaned = base
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${cleaned}_anlatim_${UZUNLUK_LABEL[a.uzunluk]}_${stamp}.${extension}`;
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

// ─── Markdown → blok dizisi (minimal parser) ────────────────────────
// Yaklaşım: çıktıyı satır satır gez. ```/``` arasını "code" bloğu yap, kalanını
// başlık/liste/paragraf olarak sınıfla. Inline `**bold**`, `*italic*`, `\`code\``,
// ![img](url) ve <gorsel ...> placeholder olarak işle.

type Block =
  | { type: "h1" | "h2" | "h3" | "h4"; text: string }
  | { type: "para"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "image"; alt: string }
  | {
      type: "table";
      headers: string[];
      alignments: ("left" | "center" | "right")[];
      rows: string[][];
    };

function toSuperscript(str: string): string {
  const sups: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "n": "ⁿ"
  };
  return str.split("").map(c => sups[c] ?? c).join("");
}

function cleanLatex(text: string): string {
  if (!text) return text;
  let cleaned = text;

  // Sık kullanılan LaTeX sembollerini unicode karşılıklarıyla değiştir
  const replacements: [RegExp, string][] = [
    [/\\rightarrow/g, "→"],
    [/\\leftarrow/g, "←"],
    [/\\approx/g, "≈"],
    [/\\times/g, "×"],
    [/\\leq/g, "≤"],
    [/\\geq/g, "≥"],
    [/\\neq/g, "≠"],
    [/\\infty/g, "∞"],
    [/\\cdot/g, "·"],
    [/\\Delta/g, "Δ"],
    [/\\pi/g, "π"],
    [/\\sigma/g, "σ"],
    [/\\mu/g, "μ"],
    [/\\alpha/g, "α"],
    [/\\beta/g, "β"],
    [/\\theta/g, "θ"],
    [/\\phi/g, "φ"],
    [/\\omega/g, "ω"],
    // Satır içi veya blok LaTeX dolar işaretlerini temizle
    [/\$\$(.*?)\$\$/g, "$1"],
    [/\$(.*?)\$/g, "$1"],
  ];

  for (const [regex, replacement] of replacements) {
    cleaned = cleaned.replace(regex, replacement);
  }

  // \text{...} kalıplarını temizle
  cleaned = cleaned.replace(/\\text\s*\{([^}]+)\}/g, "$1");

  // Üslü sayıları (Örn: 2^{32} veya 10^{38}) unicode superscript veya temiz formata çevir
  cleaned = cleaned.replace(/\^\{?([0-9+\-n]+)\}?/g, (_m, p1) => toSuperscript(p1));

  // Süslü parantezleri temizle (LaTeX kalıntıları)
  cleaned = cleaned.replace(/\{([^}]+)\}/g, "$1");

  return cleaned;
}

function stripGorselTags(line: string): string {
  // Hem ham <gorsel q="..."> hem de backend tarafından <img src=...> dönüştürvlmüş halini placeholder yap
  return line
    .replace(/<gorsel\s+q="[^"]*">([^<]*)<\/gorsel>/gi, "[Görsel: $1]")
    .replace(
      /!\[([^\]]*)\]\([^)]+\)/g,
      (_m, alt) => `[Görsel${alt ? `: ${alt}` : ""}]`,
    )
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt) => `[Görsel${alt ? `: ${alt}` : ""}]`)
    .replace(/<img[^>]*>/gi, "[Görsel]");
}

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // boş satır
    if (line.trim() === "") {
      i++;
      continue;
    }

    // tablo tespiti
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        tableLines.push(lines[j].trim());
        j++;
      }

      // En az 2 satır olmalı (Header + Separator)
      if (tableLines.length >= 2) {
        const separatorRow = tableLines[1];
        const isSeparator = /^\|(?:\s*:?-+:?\s*\|)+$/.test(separatorRow);

        if (isSeparator) {
          const parseRow = (rowStr: string) => {
            const cells = rowStr.split("|").map(c => c.trim());
            if (cells[0] === "") cells.shift();
            if (cells[cells.length - 1] === "") cells.pop();
            return cells;
          };

          const headers = parseRow(tableLines[0]).map(h => cleanLatex(h));
          const sepCells = parseRow(separatorRow);
          const alignments = sepCells.map(cell => {
            const hasLeft = cell.startsWith(":");
            const hasRight = cell.endsWith(":");
            if (hasLeft && hasRight) return "center" as const;
            if (hasRight) return "right" as const;
            return "left" as const;
          });

          const rows: string[][] = [];
          for (let k = 2; k < tableLines.length; k++) {
            const cells = parseRow(tableLines[k]).map(c => cleanLatex(c));
            while (cells.length < headers.length) {
              cells.push("");
            }
            rows.push(cells.slice(0, headers.length));
          }

          blocks.push({
            type: "table",
            headers,
            alignments,
            rows
          });

          i = j;
          continue;
        }
      }
    }

    // code fence
    const fenceMatch = /^```\s*(\w*)\s*$/.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing ```
      // Mermaid/svg kod blokları PDF'te statik render edilemiyor; placeholder göster
      if (lang === "mermaid" || lang === "svg") {
        blocks.push({
          type: "para",
          text: `[${lang.toUpperCase()} diyagramı — sadece web görünümünde]`,
        });
      } else {
        blocks.push({ type: "code", lang, text: buf.join("\n") });
      }
      continue;
    }

    // başlıklar
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length as 1 | 2 | 3 | 4;
      const type = (`h${level}`) as Block["type"];
      blocks.push({ type, text: cleanLatex(stripGorselTags(hMatch[2])) } as Block);
      i++;
      continue;
    }

    // yatay çizgi
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: cleanLatex(stripGorselTags(buf.join(" ").trim())) });
      continue;
    }

    // sırasız liste
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(cleanLatex(stripGorselTags(lines[i].replace(/^[-*]\s+/, ""))));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // sıralı liste
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(cleanLatex(stripGorselTags(lines[i].replace(/^\d+\.\s+/, ""))));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // sadece görsel satırı
    if (/^<gorsel\s+/i.test(line) || /^!\[/.test(line) || /^<img\s+/i.test(line)) {
      const alt = stripGorselTags(line).replace(/^\[Görsel:?\s*/, "").replace(/\]$/, "");
      blocks.push({ type: "image", alt });
      i++;
      continue;
    }

    // paragraf — sonraki boş satıra veya yapısal satıra kadar topla
    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === "" ||
        /^#{1,4}\s+/.test(next) ||
        /^```/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next) ||
        /^>/.test(next) ||
        /^(\s*[-*_]){3,}\s*$/.test(next) ||
        next.trim().startsWith("|")
      ) {
        break;
      }
      buf.push(next);
      i++;
    }
    blocks.push({ type: "para", text: cleanLatex(stripGorselTags(buf.join(" "))) });
  }

  return blocks;
}

// Inline parse — **bold**, *italic*, `code`. Sonuç: {text, bold?, italics?, mono?} array
type InlineFragment = {
  text: string;
  bold?: boolean;
  italics?: boolean;
  mono?: boolean;
};

function parseInline(text: string): InlineFragment[] {
  // Sıra: önce `code`, sonra **bold**, sonra *italic*
  const result: InlineFragment[] = [];
  const regex = /(\*\*[^*]+?\*\*|\*[^*]+?\*|`[^`]+?`)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      result.push({ text: text.slice(lastIndex, m.index) });
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      result.push({ text: tok.slice(2, -2), bold: true });
    } else if (tok.startsWith("*")) {
      result.push({ text: tok.slice(1, -1), italics: true });
    } else if (tok.startsWith("`")) {
      result.push({ text: tok.slice(1, -1), mono: true });
    }
    lastIndex = m.index + tok.length;
  }
  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex) });
  }
  return result.length > 0 ? result : [{ text }];
}

// ─── JSON ─────────────────────────────────────────────────────────────
export function exportAnlatimAsJSON(a: SavedAnlatim): void {
  const payload = {
    pdfName: a.pdfName,
    createdAt: new Date(a.createdAt).toISOString(),
    konuBasligi: a.konuBasligi,
    uzunluk: a.uzunluk,
    mod: a.mod,
    markdown: a.markdown,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  triggerDownload(blob, safeFilename(a, "json"));
}

// ─── PDF (pdfmake) ────────────────────────────────────────────────────
export function exportAnlatimAsPDF(a: SavedAnlatim): void {
  const blocks = parseMarkdown(a.markdown);
  const content: Content[] = [];

  content.push({ text: "Lostick AI · Konu Anlatımı", style: "title" });
  content.push({
    text: `Belge: ${a.pdfName.replace(/\.pdf$/i, "")}    ·    Uzunluk: ${UZUNLUK_LABEL[a.uzunluk]}    ·    Mod: ${MOD_LABEL[a.mod]}    ·    Tarih: ${new Date(a.createdAt).toLocaleDateString("tr-TR")}`,
    style: "meta",
  });
  content.push({
    canvas: [
      { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#cccccc" },
    ],
    margin: [0, 6, 0, 12],
  });

  for (const b of blocks) {
    if (b.type === "h1") {
      content.push({ text: b.text, style: "h1" });
    } else if (b.type === "h2") {
      content.push({ text: b.text, style: "h2" });
    } else if (b.type === "h3") {
      content.push({ text: b.text, style: "h3" });
    } else if (b.type === "h4") {
      content.push({ text: b.text, style: "h4" });
    } else if (b.type === "para") {
      content.push({
        text: parseInline(b.text).map((f) => ({
          text: f.text,
          bold: !!f.bold,
          italics: !!f.italics,
          ...(f.mono ? { font: "Roboto", color: "#B36E00" } : {}),
        })),
        style: "para",
      });
    } else if (b.type === "ul") {
      content.push({
        ul: b.items.map((it) => ({
          text: parseInline(it).map((f) => ({
            text: f.text,
            bold: !!f.bold,
            italics: !!f.italics,
          })),
        })),
        style: "para",
      });
    } else if (b.type === "ol") {
      content.push({
        ol: b.items.map((it) => ({
          text: parseInline(it).map((f) => ({
            text: f.text,
            bold: !!f.bold,
            italics: !!f.italics,
          })),
        })),
        style: "para",
      });
    } else if (b.type === "code") {
      content.push({
        text: b.text,
        style: "code",
      });
    } else if (b.type === "quote") {
      content.push({
        text: parseInline(b.text).map((f) => ({
          text: f.text,
          bold: !!f.bold,
          italics: true,
        })),
        style: "quote",
      });
    } else if (b.type === "hr") {
      content.push({
        canvas: [
          { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#dddddd" },
        ],
        margin: [0, 8, 0, 8],
      });
    } else if (b.type === "image") {
      content.push({
        text: `[Görsel${b.alt ? `: ${b.alt}` : ""}]`,
        style: "imagePlaceholder",
      });
    }
  }

  const styles: StyleDictionary = {
    title: { fontSize: 20, bold: true, margin: [0, 0, 0, 6] },
    meta: { fontSize: 9, color: "#707070", margin: [0, 0, 0, 4] },
    h1: { fontSize: 18, bold: true, margin: [0, 14, 0, 6] },
    h2: { fontSize: 16, bold: true, margin: [0, 12, 0, 5], color: "#222222" },
    h3: { fontSize: 13, bold: true, margin: [0, 10, 0, 4], color: "#333333" },
    h4: { fontSize: 11, bold: true, margin: [0, 8, 0, 4], color: "#444444" },
    para: { fontSize: 11, margin: [0, 0, 0, 6], lineHeight: 1.35 },
    code: {
      fontSize: 9,
      font: "Roboto",
      color: "#333333",
      background: "#f4f4f4",
      margin: [0, 4, 0, 8],
    },
    quote: {
      fontSize: 10,
      color: "#555555",
      margin: [12, 4, 0, 8],
    },
    imagePlaceholder: {
      fontSize: 9,
      italics: true,
      color: "#888888",
      alignment: "center",
      margin: [0, 6, 0, 6],
    },
  };

  const docDef: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [48, 56, 48, 56],
    content,
    defaultStyle: { font: "Roboto", fontSize: 11 },
    styles,
  };

  pdfMake.createPdf(docDef).download(safeFilename(a, "pdf"));
}

// ─── DOCX ─────────────────────────────────────────────────────────────
export async function exportAnlatimAsDOCX(a: SavedAnlatim): Promise<void> {
  const blocks = parseMarkdown(a.markdown);
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: "Lostick AI · Konu Anlatımı", bold: true })],
    }),
  );

  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `Belge: ${a.pdfName.replace(/\.pdf$/i, "")}    ·    Uzunluk: ${UZUNLUK_LABEL[a.uzunluk]}    ·    Mod: ${MOD_LABEL[a.mod]}    ·    Tarih: ${new Date(a.createdAt).toLocaleDateString("tr-TR")}`,
          size: 18,
          color: "707070",
        }),
      ],
    }),
  );

  function inlineRuns(text: string): TextRun[] {
    return parseInline(text).map(
      (f) =>
        new TextRun({
          text: f.text,
          bold: !!f.bold,
          italics: !!f.italics,
          size: 22,
        }),
    );
  }

  for (const b of blocks) {
    if (b.type === "h1") {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 320, after: 120 },
          children: [new TextRun({ text: b.text, bold: true })],
        }),
      );
    } else if (b.type === "h2") {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 280, after: 100 },
          children: [new TextRun({ text: b.text, bold: true })],
        }),
      );
    } else if (b.type === "h3") {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 80 },
          children: [new TextRun({ text: b.text, bold: true })],
        }),
      );
    } else if (b.type === "h4") {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_4,
          spacing: { before: 160, after: 60 },
          children: [new TextRun({ text: b.text, bold: true })],
        }),
      );
    } else if (b.type === "para") {
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          children: inlineRuns(b.text),
        }),
      );
    } else if (b.type === "ul") {
      for (const it of b.items) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: inlineRuns(it),
          }),
        );
      }
    } else if (b.type === "ol") {
      for (const it of b.items) {
        children.push(
          new Paragraph({
            numbering: { reference: "default-numbering", level: 0 },
            spacing: { after: 60 },
            children: inlineRuns(it),
          }),
        );
      }
    } else if (b.type === "code") {
      children.push(
        new Paragraph({
          spacing: { before: 80, after: 80 },
          children: [
            new TextRun({
              text: b.text,
              font: "Consolas",
              size: 18,
              color: "333333",
            }),
          ],
        }),
      );
    } else if (b.type === "quote") {
      children.push(
        new Paragraph({
          indent: { left: 360 },
          spacing: { before: 80, after: 80 },
          children: [
            new TextRun({
              text: b.text,
              italics: true,
              color: "555555",
              size: 20,
            }),
          ],
        }),
      );
    } else if (b.type === "hr") {
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 120 },
          children: [new TextRun({ text: "────────────────────────", color: "cccccc" })],
        }),
      );
    } else if (b.type === "image") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 80 },
          children: [
            new TextRun({
              text: `[Görsel${b.alt ? `: ${b.alt}` : ""}]`,
              italics: true,
              color: "888888",
              size: 18,
            }),
          ],
        }),
      );
    }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: "decimal",
              text: "%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, safeFilename(a, "docx"));
}
