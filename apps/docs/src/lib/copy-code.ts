/**
 * Starlight / Expressive Code stores fenced-block source on the copy
 * button as `data-code`, with U+007F as a newline stand-in so HTML
 * minifiers don't collapse line breaks. Browsers' `element.dataset`
 * (and some HTML rewriters) strip that C0 control, so the clipboard
 * gets `git clone …gitcd oma` and adjacent `echo … >> .env` lines
 * concatenate — corrupting PLATFORM_ROOT_SECRET.
 *
 * Rebuild the copy payload from `.ec-line .code` text at click time
 * (capture phase, before EC's handler reads `dataset.code`).
 */

export const EC_NEWLINE_PLACEHOLDER = "\u007f";

export function decodeCopyAttribute(value: string): string {
  return value.replaceAll(EC_NEWLINE_PLACEHOLDER, "\n");
}

/** Join per-line `textContent` values the way a fenced block should copy. */
export function codeFromEcLineTexts(lineTexts: readonly string[]): string {
  return lineTexts.map((t) => t.replace(/\n/g, "")).join("\n");
}

/**
 * IIFE injected via `expressiveCode.plugins[].jsModules`. Keep this a
 * single string so Astro inlines it next to EC's own copy module.
 */
export const copyFromEcLinesJsModule = `try{(()=>{
  function codeFromBlock(block){
    const lines = [...block.querySelectorAll(".ec-line .code")];
    if (!lines.length) return null;
    return lines.map((el) => (el.textContent ?? "").replace(/\\n/g, "")).join("\\n");
  }
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest(".expressive-code .copy button");
    if (!btn) return;
    const block = btn.closest(".expressive-code");
    if (!block) return;
    const text = codeFromBlock(block);
    if (text === null) return;
    btn.setAttribute("data-code", text);
  }, true);
})()}catch(e){console.error("[EC] copy-from-ec-lines failed:", e)}`;

export function copyFromEcLinesPlugin(): { name: string; jsModules: string[] } {
  return {
    name: "copy-from-ec-lines",
    jsModules: [copyFromEcLinesJsModule],
  };
}
