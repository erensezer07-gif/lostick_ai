"use client";

import { useRef, useState, KeyboardEvent, ChangeEvent } from "react";

const ACCEPTED_EXTENSIONS = [
  // PDF
  ".pdf",
  // Word & OpenDocument Text & RTF & Ebooks
  ".docx", ".docm", ".dotx", ".doc", ".odt", ".rtf", ".epub",
  // PowerPoint
  ".pptx", ".pptm", ".potx", ".ppsx", ".ppt",
  // Excel & Spreadsheets
  ".xlsx", ".xlsm", ".xltx", ".xls", ".csv", ".tsv",
  // Apple iWork
  ".pages", ".key", ".numbers",
  // Text & Notebooks
  ".txt", ".md", ".ipynb",
  // Images
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg",
  // Code & Web
  ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift", ".sql", ".sh", ".bat",
  ".html", ".css", ".scss", ".xml", ".yaml", ".yml", ".json", ".r", ".scala",
  ".pl", ".lua", ".dart", ".vue",
];
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",");

interface ChatInputProps {
  onSend: (text: string) => void;
  onUpload: (file: File) => void;
  disabled?: boolean;
  isUploading?: boolean;
  isPdfMode?: boolean;
}

export default function ChatInput({
  onSend,
  onUpload,
  disabled,
  isUploading,
  isPdfMode,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
    }
    e.target.value = "";
  }

  const attachDisabled = isUploading || disabled;
  const attachTitle = isUploading
    ? "Dosya yükleniyor..."
    : isPdfMode
      ? "Başka bir dosya yükle"
      : "Dosya yükle";

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-outline-variant/30 bg-background/95 backdrop-blur-md"
    >
      <div className="max-w-4xl mx-auto px-margin-mobile md:px-margin-desktop py-md">
        <div className="flex items-end gap-2 bg-surface-container-low border border-surface-variant focus-within:border-primary-container transition-colors rounded-lg p-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={handleFileChange}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachDisabled}
            title={attachTitle}
            aria-label={attachTitle}
            className={`flex-shrink-0 w-10 h-10 flex items-center justify-center rounded transition-colors disabled:cursor-not-allowed
              ${
                isPdfMode
                  ? "text-primary-container hover:bg-primary-container/10 disabled:text-primary-container/40"
                  : "text-on-surface-variant hover:text-primary-container hover:bg-surface-container-high disabled:text-on-surface-variant/30"
              }`}
          >
            {isUploading ? (
              <span className="w-5 h-5 border-2 border-surface-variant border-t-primary-container rounded-full animate-spin" />
            ) : (
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 20 }}
              >
                attach_file
              </span>
            )}
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isPdfMode
                ? "Belge üzerine bir soru sor..."
                : "Lostick'e bir şey sor..."
            }
            rows={1}
            disabled={disabled}
            className="flex-1 min-w-0 bg-transparent text-on-surface font-body text-body-md placeholder:text-on-surface-variant/50 focus:outline-none resize-none px-2 py-2 max-h-[200px]"
          />

          <button
            type="submit"
            disabled={!value.trim() || disabled}
            aria-label="Gönder"
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded bg-primary-container text-on-primary-container hover:bg-primary disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-colors"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 20 }}
            >
              {disabled ? "hourglass_top" : "send"}
            </span>
          </button>
        </div>
        <p className="font-mono text-label-sm text-on-surface-variant/50 mt-2 text-center">
          {isPdfMode
            ? "Belge modu aktif · Sorular yüklenen belge üzerinden yanıtlanır"
            : "Enter ile gönder · Shift + Enter ile yeni satır"}
        </p>
      </div>
    </form>
  );
}
