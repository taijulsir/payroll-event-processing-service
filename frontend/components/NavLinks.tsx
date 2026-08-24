'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SystemHealthPill } from './SystemHealthPill';
import { ThemeToggle } from './ThemeToggle';

const LINKS = [
  { href: '/', label: 'Events' },
  { href: '/submit/', label: 'Submit Event' },
];

export function NavLinks() {
  const pathname = usePathname();

  const isLinkActive = (href: string) => {
    if (href === '/') {
      return pathname === '/' || pathname === '';
    }
    return pathname?.startsWith(href) || pathname === href.replace(/\/$/, '');
  };

  return (
    <>
      <div className="nav-links-group">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`nav-link ${isLinkActive(link.href) ? 'active' : ''}`}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <div className="nav-utilities">
        <SystemHealthPill />
        <ThemeToggle />
      </div>
    </>
  );
}
