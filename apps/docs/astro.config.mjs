import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';

// Brand fonts — aligned to apps/web's current type stack (Inter Variable
// for body, Instrument Serif for display accents, JetBrains Mono for
// code); web self-hosts these via fontsource, docs pulls the same
// families from Google Fonts instead since Starlight has no fontsource
// wiring. Loaded via Starlight's head[] config rather than @import inside
// customCss so the CSS waterfall (custom.css → fonts.googleapis.com →
// fonts.gstatic.com) collapses into parallel requests. print-onload makes
// the stylesheet non-blocking; the <noscript> fallback keeps it working
// without JS.
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap';

export default defineConfig({
  site: 'https://docs.oma.duyet.net',
  integrations: [
    starlight({
      title: 'oma',
      description: 'Open-source alternative to Claude Managed Agents — self-host Claude agents on Cloudflare or Docker.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: '',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: FONT_HREF,
            media: 'print',
            onload: "this.media='all'",
          },
        },
        {
          tag: 'noscript',
          content: `<link rel="stylesheet" href="${FONT_HREF}">`,
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/duyet/oma',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/duyet/oma/edit/main/apps/docs/',
      },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: 'Get Started',
          items: [
            { label: 'Welcome', link: '/' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Concepts', slug: 'concepts' },
            { label: 'Architecture', slug: 'architecture' },
            { label: 'How it works & the hard parts', slug: 'how-it-works' },
          ],
        },
        {
          label: 'Use the Console',
          items: [
            { label: 'Getting Started', slug: 'console/getting-started' },
            {
              label: 'Connect Integrations',
              slug: 'console/integrations',
            },
          ],
        },
        {
          label: 'Build with the API',
          items: [
            { label: 'REST API', slug: 'build/api' },
            { label: 'Agent Schedules', slug: 'build/schedules' },
            { label: 'CLI & SDK', slug: 'build/cli-sdk' },
            { label: 'Skills & Tools', slug: 'build/skills-and-tools' },
            { label: 'Vault & MCP', slug: 'build/vault-and-mcp' },
            { label: 'Custom Integrations', slug: 'build/integrations' },
          ],
        },
        {
          label: 'Self-host',
          items: [
            { label: 'Overview', slug: 'self-host/overview' },
            { label: 'Node + Docker (no Cloudflare)', slug: 'self-host/node-docker' },
            { label: 'Deploy on Cloudflare', slug: 'self-host/deploy' },
            { label: 'OAuth Apps', slug: 'self-host/oauth-apps' },
            { label: 'Operations', slug: 'self-host/operations' },
          ],
        },
        {
          label: 'Deploy Guides',
          items: [
            { label: 'Overview', slug: 'deploy' },
            { label: 'Docker', slug: 'deploy/docker' },
            { label: 'Cloudflare', slug: 'deploy/cloudflare' },
            { label: 'Kubernetes', slug: 'deploy/kubernetes' },
            { label: 'K8s Bridge Reference', slug: 'deploy/k8s-bridge' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'API Endpoints', slug: 'reference/api' },
            { label: 'Glossary', slug: 'reference/glossary' },
          ],
        },
        {
          label: 'Contribute',
          items: [
            { label: 'Contributing', slug: 'contribute' },
            { label: 'State Machines', slug: 'contribute/state-machines' },
            { label: 'Recovery & Idempotency', slug: 'contribute/recovery-and-idempotency' },
          ],
        },
        {
          // ↗ glyph in label is load-bearing: Starlight 0.38.4 doesn't
          // paint an external-link affordance on sidebar entries, so
          // without this prefix the Console link looks identical to
          // internal docs links.
          label: '↗ Console',
          link: 'https://app.oma.duyet.net',
          attrs: { target: '_blank', rel: 'noopener' },
        },
      ],
    }),
    mdx(),
  ],
});
