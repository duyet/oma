---
title: "Site Redesign: Aligning OMA with the AnyRouter Design System"
description: "We rebuilt the oma.duyet.net design tokens on shadcn + the AnyRouter visual language — amber primary, Inter Variable, JetBrains Mono, one shared component recipe across the gateway and the agent platform."
publishedAt: 2026-07-24
author: OMA
tags: ["design", "shadcn", "anyrouter", "frontend"]
---

We just shipped a visual refresh of this site. If you've used
[AnyRouter](https://anyrouter.dev) recently, the buttons, cards, and
color palette here will look familiar — that's on purpose.

## Why

OMA and AnyRouter are two halves of the same story: AnyRouter is the
unified LLM gateway, OMA is the agent platform that runs on top of it.
A lot of people move between the two — connecting an OMA model card to
AnyRouter, checking credit balance, wiring up a starter agent. Up to
now the two products didn't look related at all. OMA ran a bespoke
zinc-and-terracotta "engineering tool" palette; AnyRouter had already
settled on a cleaner shadcn-based system. Switching contexts felt like
switching products, because it was.

Bringing OMA onto the same design language removes that seam. One
button recipe, one type scale, one color system, whether you're
looking at a pricing page, a model-card picker, or a blog post.

## What changed

We applied a shadcn preset built on AnyRouter's tokens
(`pnpm dlx shadcn@latest apply`) rather than hand-rolling the
migration, which gave us a base to work from instead of guessing at
values one component at a time:

- **Neutral base, amber primary.** The interface itself stays
  neutral — background, borders, muted text — and color is reserved
  for the one thing that should draw the eye: the primary action.
  Primary is `oklch(0.555 0.163 48.998)`, the same amber AnyRouter
  uses for its CTAs and active states.
- **Type stack.** Inter Variable carries body text, JetBrains Mono
  handles anything code-shaped (inline code, blog code fences, the
  small-caps metadata rows on post cards), and Instrument Serif shows
  up as an italic display accent in headings — a deliberate contrast
  note rather than a whole second body font.
- **Radius and buttons.** `0.625rem` corner radius across the board,
  and buttons now follow the shadcn/AnyRouter recipe: rounded-2xl,
  `h-8`/`h-9` sizing, solid amber fill with a hover state that dims to
  80% opacity instead of swapping hue. Outline buttons match — border
  + background, muted hover, no color shift.
- **Dark mode from the same variables.** Nothing here is a separate
  dark theme; every token flips through `prefers-color-scheme` (or the
  stored override), so light and dark stay in sync as the palette
  evolves instead of drifting into two systems.
- **Legacy aliases kept working.** A lot of existing markup here
  referenced the old token names — `--color-bg`, `--color-fg`,
  `--color-brand`, and friends. Rather than rewrite every page in one
  pass, those aliases now resolve onto the new shadcn variables
  underneath. The visual system changed; most of the markup didn't
  have to.

## What it means going forward

New pages and components on oma.duyet.net should reach for the shadcn
semantic utilities directly — `bg-background`, `text-foreground`,
`bg-muted`, `text-muted-foreground`, `bg-primary`, `border-border` —
rather than the legacy aliases, which exist for compatibility, not as
the preferred path. The button and card recipes from this pass are the
reference implementation for anything new.

If you're building against AnyRouter and OMA together, you shouldn't
notice a design gap between them anymore. That was the point.
