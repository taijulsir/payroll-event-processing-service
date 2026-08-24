import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import { NavLinks } from '../components/NavLinks';

export const metadata: Metadata = {
  title: 'Payroll Event Processing',
  description: 'Operations console for asynchronous payroll event processing and audit telemetry.',
  icons: {
    icon: '/icon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <header className="app-header">
          <div className="app-header__container">
            <Link href="/" className="app-brand" aria-label="Payroll Event Processing Home">
              <div className="app-brand__icon">⚡</div>
              <span className="app-brand__title">Payroll Event Processing</span>
            </Link>
            <nav className="app-nav" aria-label="Primary Navigation">
              <NavLinks />
            </nav>
          </div>
        </header>
        <main className="app-main">{children}</main>
      </body>
    </html>
  );
}
