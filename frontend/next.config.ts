import type { NextConfig } from 'next';

/**
 * Static export (architecture.md §19/§20: "a small static build served by a lightweight
 * server, its own container") — this frontend has no server-side rendering needs and no API
 * routes of its own; every page is a client component that talks to the real backend API
 * directly from the browser. `next build` produces a plain `out/` directory of static
 * HTML/JS/CSS, served by nginx (see Dockerfile) — no Next.js Node process runs in production.
 *
 * `images.unoptimized` is required by static export (Next's built-in image optimizer needs a
 * running server) — not otherwise relevant here since this app has no images.
 */
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // Next.js 16 otherwise auto-generates a generic AGENTS.md/CLAUDE.md pair on every `next
  // dev`/`next build` — disabled: this repo already has its own root CLAUDE.md with real,
  // project-specific conventions, and a second, generic, auto-regenerating one inside
  // frontend/ would only be confusing noise, not something this phase asked for.
  agentRules: false,
  // Directory + index.html per route (`/submit/index.html`, `/event/index.html`) rather than
  // `/submit.html` — lets the static server (nginx, see Dockerfile) serve every route with
  // its own default `index index.html` directive, no rewrite rules needed.
  trailingSlash: true,
};

export default nextConfig;
