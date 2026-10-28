const legalLinks = [
  { label: "Gizlilik Politikası", href: "#" },
  { label: "Kullanım Şartları", href: "#" },
  { label: "API Dokümantasyonu", href: "#" },
];

const resourceLinks = [
  { label: "Araştırma Makaleleri", href: "#" },
  { label: "Destek İletişim", href: "#" },
];

export default function Footer() {
  return (
    <footer className="bg-surface-container-lowest border-t border-outline-variant/20 w-full">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-gutter px-margin-mobile md:px-margin-desktop py-xl max-w-7xl mx-auto">
        <div className="col-span-1 md:col-span-2">
          <div className="font-display font-extrabold text-headline-md text-primary-container mb-4">
            Lostick
          </div>
          <p className="font-mono text-label-sm text-on-surface-variant mb-4">
            Hassas Öğrenme Ortamları.
          </p>
          <p className="font-mono text-label-sm text-on-surface-variant">
            © {new Date().getFullYear()} Lostick. Tüm Hakları Saklıdır.
          </p>
        </div>

        <div className="col-span-1 flex flex-col gap-sm">
          {legalLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="font-mono text-label-sm text-on-surface-variant hover:text-primary-container transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="col-span-1 flex flex-col gap-sm">
          {resourceLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="font-mono text-label-sm text-on-surface-variant hover:text-primary-container transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
