'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Events' },
  { href: '/submit', label: 'Submit Event' },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={pathname === link.href ? 'active' : undefined}
        >
          {link.label}
        </Link>
      ))}
    </>
  );
}
