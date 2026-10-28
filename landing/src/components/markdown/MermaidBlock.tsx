"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

// Lostick AI dark + gold design tokens.
// Strateji: koyu node fill + altın border + AÇIK metin renkleri.
// (Önceki sürümde primaryTextColor koyu kahverengiydi, koyu zeminde okunmuyordu.)
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "loose",
  theme: "base",
  themeVariables: {
    darkMode: true,
    background: "#0e0e0e",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "14px",
    // Node renkleri
    primaryColor: "#201f1f",
    primaryTextColor: "#e5e2e1",
    primaryBorderColor: "#fabd00",
    secondaryColor: "#2a2a2a",
    secondaryTextColor: "#e5e2e1",
    secondaryBorderColor: "#fabd00",
    tertiaryColor: "#1c1b1b",
    tertiaryTextColor: "#e5e2e1",
    tertiaryBorderColor: "#fabd00",
    mainBkg: "#201f1f",
    secondBkg: "#2a2a2a",
    // Edges & labels
    lineColor: "#9c8f78",
    textColor: "#e5e2e1",
    nodeBorder: "#fabd00",
    nodeTextColor: "#e5e2e1",
    edgeLabelBackground: "#0e0e0e",
    // Subgraph / cluster
    clusterBkg: "#1c1b1b",
    clusterBorder: "#fabd00",
    titleColor: "#ffc107",
    // Sequence diagram
    actorBkg: "#201f1f",
    actorBorder: "#fabd00",
    actorTextColor: "#e5e2e1",
    actorLineColor: "#9c8f78",
    signalColor: "#e5e2e1",
    signalTextColor: "#e5e2e1",
    labelBoxBkgColor: "#2a2a2a",
    labelBoxBorderColor: "#fabd00",
    labelTextColor: "#e5e2e1",
    loopTextColor: "#e5e2e1",
    noteBorderColor: "#fabd00",
    noteBkgColor: "#2a2a2a",
    noteTextColor: "#e5e2e1",
  },
});

interface MermaidBlockProps {
  code: string;
}

export default function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;

    (async () => {
      try {
        // ÖNCE parse et: geçersizse Mermaid'in DOM'a "Syntax error in text" bombasını
        // enjekte etmesini engelleriz (suppressErrors: throw etmez, false döner).
        const valid = await mermaid.parse(code, { suppressErrors: true });
        if (!valid) {
          if (!cancelled) {
            setError("Diyagram söz dizimi geçersiz (Mermaid tarafından çizilemedi).");
            setSvg(null);
          }
          return;
        }
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Diyagram render edilemedi.";
          setError(msg);
          setSvg(null);
        }
      } finally {
        // Mermaid'in body'ye bıraktığı geçici/temizlenmemiş ölçüm düğümlerini kaldır
        if (typeof document !== "undefined") {
          document.getElementById(id)?.remove();
          document.getElementById("d" + id)?.remove();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="bg-error-container/15 border border-error/40 rounded-lg p-3 my-4">
        <div className="flex items-center gap-2 mb-2">
          <span
            className="material-symbols-outlined text-error"
            style={{ fontSize: 16 }}
          >
            error
          </span>
          <p className="font-mono text-label-sm text-error uppercase tracking-widest">
            Mermaid Render Hatası
          </p>
        </div>
        <p className="font-mono text-label-sm text-on-surface-variant mb-2 [overflow-wrap:anywhere]">
          {error}
        </p>
        <pre className="font-mono text-xs text-on-surface-variant/70 bg-surface-container-lowest border border-surface-variant rounded p-2 overflow-x-auto">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <figure className="my-4 bg-surface-container-lowest border border-surface-variant rounded-lg p-4 overflow-x-auto">
      <div
        ref={containerRef}
        className={[
          "flex justify-center",
          "[&>svg]:max-w-full [&>svg]:h-auto",
          // Mermaid bazen tema değişkenlerini görmezden gelip inline fill atıyor —
          // node/cluster label'larına !important ile açık renk dayatıyoruz.
          "[&_.nodeLabel]:!fill-[#e5e2e1] [&_.nodeLabel]:!text-[#e5e2e1]",
          "[&_.edgeLabel]:!fill-[#e5e2e1] [&_.edgeLabel]:!text-[#e5e2e1]",
          "[&_.cluster-label_text]:!fill-[#ffc107]",
          "[&_.cluster-label_p]:!text-[#ffc107]",
          "[&_.label_p]:!text-[#e5e2e1]",
          "[&_text]:!fill-[#e5e2e1]",
          "[&_.edgeLabel_rect]:!fill-[#0e0e0e]",
        ].join(" ")}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      {!svg && !error && (
        <div className="flex items-center justify-center gap-2 py-4">
          <span className="w-2 h-2 rounded-full bg-primary-container animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2 h-2 rounded-full bg-primary-container animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2 h-2 rounded-full bg-primary-container animate-bounce" />
          <span className="font-mono text-label-sm text-on-surface-variant ml-1">
            Diyagram çiziliyor
          </span>
        </div>
      )}
    </figure>
  );
}
