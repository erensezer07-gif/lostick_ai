"use client";

import { useMemo } from "react";
import DOMPurify from "dompurify";

interface SvgBlockProps {
  code: string;
  caption?: string;
}

/**
 * LLM tarafından üretilen inline SVG illüstrasyonlarını güvenli şekilde render eder.
 * - DOMPurify ile XSS riski olan script/event-handler attribute'ları temizler
 * - SVG profili izin verilen elementleri (rect, circle, path, text, vs.) korur
 * - Container'a sığdırmak için max-width sınırı uygular
 */
export default function SvgBlock({ code, caption }: SvgBlockProps) {
  const clean = useMemo(() => {
    return DOMPurify.sanitize(code, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: ["viewBox", "preserveAspectRatio"],
    });
  }, [code]);

  if (!clean.trim()) {
    return (
      <div className="bg-error-container/15 border border-error/40 rounded-lg p-3 my-4">
        <p className="font-mono text-label-sm text-error uppercase tracking-widest">
          SVG İllüstrasyonu Boş Geldi
        </p>
      </div>
    );
  }

  return (
    <figure className="my-4 bg-surface-container-lowest border border-surface-variant rounded-lg p-4 overflow-x-auto">
      <div
        className="flex justify-center [&>svg]:max-w-full [&>svg]:h-auto"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: clean }}
      />
      {caption && (
        <figcaption className="mt-3 text-center font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
