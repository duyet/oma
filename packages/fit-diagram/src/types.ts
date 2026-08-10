import type { ReactNode } from "react";

export type FitCardStatus = "ready" | "attention" | "empty";

/** Tinted icon chip on a card. Resolves via theme tokens so light/dark both read. */
export type FitAccent =
  | "brand"
  | "sky"
  | "emerald"
  | "violet"
  | "rose"
  | "amber"
  | "slate";

/** A provider mark in a card's avatar-group. A bare string renders colored
 *  (active); the object form can mark it inactive for a grayed-out look. */
export type FitProviderMark = string | { id: string; active?: boolean };

export interface FitCard {
  /** Stable identity within a step — used as the React key. */
  key: string;
  icon?: ReactNode;
  /** Icon-chip tint. Defaults to brand for hero cards, slate otherwise. */
  accent?: FitAccent;
  /** Component TYPE — "Model card", "Environment", … never an instance name. */
  title: string;
  /** Real instance names shown as badges (capped at 3 + "+N"). */
  badges?: string[];
  /** Static explainer shown *instead of* badges — for pieces you don't
   *  create-and-name (a Session, the Sandbox), or the click-to-describe
   *  body text on the static/demo surface. */
  description?: string;
  /** Short one-line note under the title — lighter-weight than `description`. */
  note?: string;
  /** Drives the status dot color. Omit for a demo card with no live state. */
  status?: FitCardStatus;
  /** CTA text shown when `status === "empty"` and no badges are set. */
  emptyCta?: string;
  /** Dashed border + reduced opacity — the "not set up yet" / example look,
   *  independent of `status` (used by the static demo surface). */
  dashed?: boolean;
  /** The hero card — brand-accented and a size up. */
  hero?: boolean;
  /** Provider ids rendered as an overlapping avatar-group of ProviderMarks.
   *  A plain string renders colored (the default). An object form lets a
   *  consumer mark a provider inactive — `active: false` renders the mark
   *  grayed out, so a live-status surface can show healthy vs. idle at a
   *  glance. */
  providerMarks?: FitProviderMark[];
  /** Card click handler — console navigates, the landing page opens a dialog. */
  onActivate?: () => void;
}

/** A step's contents, top to bottom. A nested array is one ROW — cards that
 *  sit side by side because they're peers of each other. */
export type FitRow = FitCard | FitCard[];

export interface FitStep {
  number: string;
  name: string;
  optional?: boolean;
  done?: boolean;
  cards: FitRow[];
  /** Chain the cards with ↓ pointers instead of plain gaps. */
  chain?: boolean;
  /** Labels for the chain's ↓ pointers (index i annotates the arrow before
   *  row i+1). */
  chainLabels?: string[];
  /** Extra width share on wide layouts. */
  wide?: boolean;
  /** Soft column accent — tints the step header number + panel edge. */
  accent?: FitAccent;
}

export interface FitFormulaRow {
  lhs: string;
  parts: string[];
}
