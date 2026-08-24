import type { Metadata } from 'next';
import './globals.css';
import { NavLinks } from '../components/NavLinks';

export const metadata: Metadata = {
  title: 'Payroll Event Processing',
  description: 'Demonstration frontend for the Payroll Event Processing Service',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header__inner">
            <span className="site-title">Payroll Event Processing</span>
            <nav className="site-nav" aria-label="Primary">
              <NavLinks />
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
