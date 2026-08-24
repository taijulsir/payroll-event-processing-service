'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { SystemHealthPill } from './SystemHealthPill';
import { ThemeToggle } from './ThemeToggle';

interface NavSection {
  title: string;
  items: {
    href: string;
    label: string;
    icon: React.ReactNode;
  }[];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isLinkActive = (href: string) => {
    if (href === '/') {
      return pathname === '/' || pathname === '';
    }
    return pathname?.startsWith(href) || pathname === href.replace(/\/$/, '');
  };

  const navSections: NavSection[] = [
    {
      title: 'Overview',
      items: [
        {
          href: '/',
          label: 'Dashboard',
          icon: (
            <svg
              className="nav-item-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
            </svg>
          ),
        },
      ],
    },
    {
      title: 'Operations',
      items: [
        {
          href: '/events/',
          label: 'Events',
          icon: (
            <svg
              className="nav-item-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M3 3.5A1.5 1.5 0 014.5 2h9A1.5 1.5 0 0115 3.5v13a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 013 16.5v-13zM6 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7zm0 4a1 1 0 100 2h4a1 1 0 100-2H7z"
                clipRule="evenodd"
              />
            </svg>
          ),
        },
        {
          href: '/submit/',
          label: 'Submit Event',
          icon: (
            <svg
              className="nav-item-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                clipRule="evenodd"
              />
            </svg>
          ),
        },
      ],
    },
    {
      title: 'Monitoring',
      items: [
        {
          href: '/health/',
          label: 'Health',
          icon: (
            <svg
              className="nav-item-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"
                clipRule="evenodd"
              />
            </svg>
          ),
        },
        {
          href: '/metrics/',
          label: 'Metrics',
          icon: (
            <svg
              className="nav-item-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
            </svg>
          ),
        },
      ],
    },
  ];

  const getBreadcrumbTitle = () => {
    if (pathname === '/' || pathname === '') return 'Dashboard';
    if (pathname?.startsWith('/events')) return 'Operations / Events';
    if (pathname?.startsWith('/event')) return 'Operations / Event Inspection';
    if (pathname?.startsWith('/submit')) return 'Operations / Submit Event';
    if (pathname?.startsWith('/health')) return 'Monitoring / System Health';
    if (pathname?.startsWith('/metrics')) return 'Monitoring / Operational Metrics';
    return 'Console';
  };

  return (
    <div className="app-shell">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside className={`app-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-brand-mark" aria-hidden="true">
            ⚡
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-title">Payroll Events</span>
            <span className="sidebar-brand-sub">Operations Console</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Sidebar Navigation">
          {navSections.map((section) => (
            <div key={section.title} className="nav-section">
              <span className="nav-section-title">{section.title}</span>
              {section.items.map((item) => {
                const active = isLinkActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`nav-item ${active ? 'active' : ''}`}
                    onClick={() => setSidebarOpen(false)}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <SystemHealthPill />
          <span className="sidebar-version">v0.1.0</span>
        </div>
      </aside>

      {/* Main Content Column */}
      <div className="app-main-col">
        <header className="app-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              className="mobile-nav-toggle"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle navigation menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <div className="topbar-breadcrumb">
              <span>Console</span>
              <span>/</span>
              <strong>{getBreadcrumbTitle()}</strong>
            </div>
          </div>

          <div className="topbar-actions">
            {pathname !== '/submit/' && (
              <Link href="/submit/" className="btn btn-primary btn-sm">
                + Submit Event
              </Link>
            )}
            <ThemeToggle />
          </div>
        </header>

        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
