"use client";

import { useEffect, useState } from "react";

export interface ToastItem {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warning";
}

export default function ToastNotification() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    function handleShowToast(e: Event) {
      const ce = e as CustomEvent<{ message: string; type: ToastItem["type"] }>;
      if (!ce.detail || !ce.detail.message) return;

      const newToast: ToastItem = {
        id: `toast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        message: ce.detail.message,
        type: ce.detail.type || "info",
      };

      setToasts((prev) => [...prev, newToast]);

      // Automatically remove toast after 5 seconds
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== newToast.id));
      }, 5000);
    }

    window.addEventListener("lostick:toast", handleShowToast);
    return () => {
      window.removeEventListener("lostick:toast", handleShowToast);
    };
  }, []);

  function handleClose(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 max-w-sm w-full pointer-events-none">
      <style>{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        .animate-slide-in-right {
          animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
      {toasts.map((toast) => {
        let typeStyles = "";
        let iconName = "";

        switch (toast.type) {
          case "success":
            typeStyles = "bg-emerald-950/90 border-emerald-500/30 text-emerald-300 shadow-emerald-950/20";
            iconName = "check_circle";
            break;
          case "error":
            typeStyles = "bg-red-950/90 border-red-500/30 text-red-300 shadow-red-950/20";
            iconName = "error";
            break;
          case "warning":
            typeStyles = "bg-amber-950/90 border-amber-500/30 text-amber-300 shadow-amber-950/20";
            iconName = "warning";
            break;
          case "info":
          default:
            typeStyles = "bg-sky-950/90 border-sky-500/30 text-sky-300 shadow-sky-950/20";
            iconName = "info";
            break;
        }

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 border backdrop-blur-md rounded-xl p-4 shadow-lg transition-all duration-300 transform translate-y-0 animate-slide-in-right ${typeStyles}`}
          >
            <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: 20 }}>
              {iconName}
            </span>
            <div className="flex-1 font-body text-body-md leading-relaxed pr-2 [overflow-wrap:anywhere]">
              {toast.message}
            </div>
            <button
              onClick={() => handleClose(toast.id)}
              className="text-current opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Kapat"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                close
              </span>
            </button>
          </div>
        );
      })}
    </div>

  );
}
