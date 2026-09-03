import type { KeyboardEvent } from "react";

export { cn } from "cn";

/**
 * `onKeyDown` handler for a row/card that's clickable (onClick + role=
 * "button" + tabIndex=0) so it's also operable from the keyboard. Enter
 * and Space both activate (Space is prevented from scrolling the page).
 *
 * Guards against double-activation when the row contains its own
 * focusable descendants (e.g. a row-action ⋯ menu button): if the event
 * bubbled up from a focused child rather than originating on the row
 * itself, it's ignored — the child's own key handling (native button
 * Enter/Space → click) runs unaffected, exactly like clicking it with a
 * mouse already didn't trigger the row's onClick (RowActionsMenu's
 * trigger already stops click propagation for that reason; this handles
 * the keyboard-only path click propagation can't cover).
 */
export function rowActivateKeyDown(onActivate: () => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  };
}
