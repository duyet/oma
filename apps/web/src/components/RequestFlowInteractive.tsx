// "What one request touches" — an interactive walkthrough of the durable
// request path every message runs through. The pipeline reuses the site's
// existing .arch-path / .arch-node / .arch-node-glyph blueprint grammar from
// global.css (so the static markup is meaningful without JS); a React island
// layers interaction on top: an autoplay that steps through the nodes,
// auto-pauses on hover, and lets a click pin a step to read its full
// explanation. Mirrors the auto-advance cadence already used by
// UseCasesInteractive, so the two demos share one motion language.
// Reduced-motion users get every panel rendered statically and no timers.
import { useEffect, useRef, useState } from "react";

type Step = {
  icon: string;
  name: string;
  sub: string;
  /** Full sentence shown in the expanded panel. */
  body: string;
};

// Same glyph set as Icon.astro — inlined here because a .tsx island can't
// import an .astro component.
const GLYPHS: Record<string, string> = {
  workflow: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  repeat:
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  box: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z",
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
};

const STEPS: Step[] = [
  {
    icon: "workflow",
    name: "Request",
    sub: "user.message (SSE)",
    body: "Your message streams in over SSE. The harness appends it to the session's event log first — written durably before anything else runs — then hands it to the model loop.",
  },
  {
    icon: "layers",
    name: "Session",
    sub: "event log · DO-SQLite",
    body: "A Durable Object backed by SQLite holds the one source of truth: an append-only event log of every turn, tool call, and result. Because events land before they're acted on, a crashed turn always replays from a known-good state.",
  },
  {
    icon: "repeat",
    name: "Harness",
    sub: "model loop · tools",
    body: "The harness reads the log, rebuilds context, calls the LLM, and routes tool calls into the sandbox. It's the swappable brain — default, claude-agent-sdk, acp-proxy, long-running, or poolside — and the loop that drives the whole turn.",
  },
  {
    icon: "box",
    name: "Sandbox",
    sub: "bash · read · write · MCP",
    body: "Tools run in an isolated container the environment provisions per session. The agent shells in, runs code, and reads/writes files that get snapshotted back — it never owns the box.",
  },
  {
    icon: "globe",
    name: "Vault proxy",
    sub: "injects creds",
    body: "Outbound requests from the sandbox are intercepted by an outbound proxy that injects the matching vault credential by URL. Raw tokens never enter the sandbox the agent controls.",
  },
];

const STEP_TIME = 3200;

function Glyph({ name }: { name: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g dangerouslySetInnerHTML={{ __html: GLYPHS[name] }} />
    </svg>
  );
}

export default function RequestFlowInteractive() {
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Hover pauses autoplay; the value tracks which node (if any) is hovered.
  const hoverRef = useRef<number | null>(null);
  const reduceMotion =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => setMounted(true), []);

  // Autoplay cadence — advances the active step unless a human is hovering or
  // has pinned a step. Reduced-motion users get no timers.
  useEffect(() => {
    if (!mounted || reduceMotion) return;
    const id = window.setInterval(() => {
      if (hoverRef.current === null && !pinned) {
        setActive((a) => (a + 1) % STEPS.length);
      }
    }, STEP_TIME);
    return () => window.clearInterval(id);
  }, [mounted, pinned, reduceMotion]);

  return (
    <div className="wf-flow-explained">
      <style>{`
        .wf-flow-explained { width: 100%; }
        /* Horizontal scroll shell for .arch-path (min-width 42rem) so mobile
           never gets page-level overflow; rail stays legible at full size. */
        .wf-path-scroll {
          width: 100%;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          padding-bottom: 0.35rem;
        }
        /* Progress dot rail — 44px hit targets (padding around a small visual
           pip) so touch/keyboard users aren't hunting a 7px circle. */
        .wf-dots {
          display: flex; justify-content: center; align-items: center;
          gap: 0.15rem; margin-bottom: 1.25rem;
        }
        .wf-dot {
          box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center;
          width: 44px; height: 44px; padding: 0; margin: 0;
          border: 0; background: transparent; cursor: pointer;
          border-radius: 999px;
        }
        .wf-dot::after {
          content: "";
          width: 8px; height: 8px; border-radius: 999px;
          background: color-mix(in srgb, var(--color-fg) 22%, transparent);
          border: 1px solid color-mix(in srgb, var(--color-fg) 18%, transparent);
          transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
        }
        .wf-dot.is-active::after {
          background: var(--color-brand); border-color: var(--color-brand);
          transform: scale(1.15);
        }
        .wf-dot:focus-visible {
          outline: 2px solid var(--color-brand); outline-offset: 2px;
        }
        .wf-dot:hover::after {
          background: color-mix(in srgb, var(--color-brand) 55%, transparent);
          border-color: var(--color-brand);
        }
        /* Explanatory panel */
        .wf-panel { margin-top: 1.75rem; text-align: center; }
        .wf-panel-title {
          font-family: var(--font-mono); font-size: 0.64rem; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-brand);
        }
        .wf-panel-body {
          margin-top: 0.6rem; max-width: 38rem; margin-left: auto; margin-right: auto;
          border: 1px solid var(--color-border); border-radius: 0.75rem;
          background: color-mix(in srgb, var(--color-brand) 4%, var(--color-card));
          padding: 1rem 1.25rem; font-size: 0.82rem; line-height: 1.6; color: var(--color-fg-muted);
        }
        @media (prefers-reduced-motion: no-preference) {
          .wf-panel-body { transition: opacity 120ms ease, transform 120ms ease; }
        }
        /* Active node tint — layered over the .arch-node glyph so the blueprint
           grammar in global.css keeps doing the heavy lifting. */
        .wf-step.is-active .arch-node-glyph,
        .wf-node-btn:hover .arch-node-glyph {
          border-color: var(--color-brand);
          box-shadow: 0 1px 2px rgba(24, 24, 27, 0.05), 0 0 0 3px color-mix(in srgb, var(--color-brand) 35%, transparent);
        }
        .wf-node-btn {
          background: none; border: 0; margin: 0; cursor: pointer;
          /* Pad the whole node so the click/tap target clears ~44px tall. */
          display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
          padding: 0.5rem 0.35rem; min-width: 4.5rem; min-height: 44px;
          border-radius: 0.6rem;
        }
        .wf-node-btn:focus-visible .arch-node-glyph {
          outline: 2px solid var(--color-brand); outline-offset: 2px;
        }
      `}</style>

      <div className="wf-dots" role="tablist" aria-label="Request path steps">
        {STEPS.map((s, i) => (
          <button
            key={s.name}
            type="button"
            role="tab"
            id={`wf-tab-${i}`}
            aria-selected={i === active}
            aria-controls="wf-panel"
            aria-label={`Step ${i + 1} of ${STEPS.length}: ${s.name} — ${s.sub}`}
            title={`${s.name}: ${s.sub}`}
            className={`wf-dot ${i === active ? "is-active" : ""}`}
            onMouseEnter={() => { hoverRef.current = i; }}
            onMouseLeave={() => { hoverRef.current = null; }}
            onClick={() => { setPinned(true); setActive(i); }}
          />
        ))}
      </div>

      {/* Pipeline — .arch-path / .arch-node reuse the blueprint rail from
          global.css. Each node is a keyboard+touch button; hover/pause keeps
          the autoplay readable. Scroll shell contains min-width on mobile. */}
      <div className="wf-path-scroll">
        <ol className="arch-path">
          {STEPS.map((s, i) => {
            const isActive = i === active;
            return (
              <li key={s.name} className={`arch-node wf-step${isActive ? " is-active" : ""}`}>
                <button
                  type="button"
                  className="wf-node-btn"
                  aria-pressed={isActive}
                  aria-expanded={isActive}
                  aria-controls="wf-panel"
                  aria-label={`Show ${s.name} step: ${s.sub}`}
                  onMouseEnter={() => { hoverRef.current = i; }}
                  onMouseLeave={() => { hoverRef.current = null; }}
                  onClick={() => { setPinned(true); setActive(i); }}
                >
                  <span className="arch-node-glyph">
                    <Glyph name={s.icon} />
                  </span>
                  <span className="arch-node-name">{s.name}</span>
                  <span className="arch-node-sub">{s.sub}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div
        id="wf-panel"
        className="wf-panel"
        role="tabpanel"
        aria-labelledby={`wf-tab-${active}`}
      >
        <p className="wf-panel-title">{STEPS[active].name} — what runs here</p>
        <div className="wf-panel-body" aria-live="polite">
          <p>{STEPS[active].body}</p>
        </div>
      </div>
    </div>
  );
}
