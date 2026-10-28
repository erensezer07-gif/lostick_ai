import type { Metadata } from "next";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Şifremi Unuttum — Lostick AI",
  description: "Lostick AI hesap şifrenizi sıfırlayın.",
};

export default function ForgotPasswordPage() {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "radial-gradient(circle at top center, #1c1c1c 0%, #131313 100%)",
      }}
    >
      {/* Minimal Header */}
      <header className="w-full sticky top-0 bg-surface z-50">
        <div className="flex justify-between items-center w-full px-margin-mobile md:px-margin-desktop py-base max-w-full mx-auto border-b border-surface-container-high md:border-none shadow-sm md:shadow-none">
          <Link
            href="/"
            className="font-display font-extrabold text-headline-md text-primary tracking-tight"
          >
            Lostick
          </Link>
          <div className="flex items-center gap-sm">
            <Link
              href="/login"
              className="font-mono text-label-sm text-primary-container hover:text-primary transition-colors px-4 py-2 font-semibold"
            >
              Giriş Yap
            </Link>
            <Link
              href="/register"
              className="hidden sm:inline-flex font-mono text-label-sm bg-primary-container text-on-primary-container px-5 py-2 rounded hover:bg-primary transition-colors font-bold"
            >
              Kayıt Ol
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex items-center justify-center px-margin-mobile md:px-margin-desktop py-sm">
        <ForgotPasswordForm />
      </main>
    </div>
  );
}
