import { describe, it, expect } from "vitest";
import browserVmHostRoutes from "./browser-vm-host";

/**
 * The host page is a hand-written inline document with no bundler or type
 * checker in front of it, so these tests stand in for both: they compile the
 * emitted script, assert every element the script reaches for exists, and pin
 * the serial-console framing rules the engine's correctness rests on.
 */
async function fetchPage(): Promise<string> {
  const res = await browserVmHostRoutes.request("/");
  return await res.text();
}

function inlineScript(html: string): string {
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error("host page has no inline script");
  return m[1];
}

describe("browser-vm host page", () => {
  it("serves the host page with cross-origin isolation headers", async () => {
    const res = await browserVmHostRoutes.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("embeds the registration + relay contract the platform depends on", async () => {
    const html = await fetchPage();
    // Pairing: exchanges the one-time code with the browser-vm kind so
    // pickOnlineRuntimeId's kind filter can find this runtime.
    expect(html).toContain("/agents/runtime/exchange");
    expect(html).toContain('kind: "browser-vm"');
    // Relay: attaches via access_token query param (browser WS can't set
    // an Authorization header) and speaks sandbox.op / sandbox.result.
    expect(html).toContain("/agents/runtime/_attach?access_token=");
    expect(html).toContain("sandbox.op");
    expect(html).toContain("sandbox.result");
    // Ops served against the engine seam.
    for (const op of ["exec", "readFile", "writeFile", "setEnvVars", "destroy"]) {
      expect(html).toContain(`"${op}"`);
    }
  });

  it("ships CORS-safe public defaults so Open sandbox tab boots without a setup form", async () => {
    const html = await fetchPage();
    // Without these, a freshly paired tab pairs but fails every op with
    // "no VM image configured". Defaults must be CORP-friendly CDNs.
    expect(html).toContain("DEFAULT_V86_LIB");
    expect(html).toContain("cdn.jsdelivr.net/npm/v86@");
    expect(html).toContain("DEFAULT_V86_IMAGE");
    expect(html).toContain("cdn.jsdelivr.net/gh/copy/images");
    expect(html).toContain("DEFAULT_V86_BIOS");
    expect(html).toContain("bios/seabios.bin");
  });

  it("documents exec (not SSH) and keeps the relay alive while backgrounded", async () => {
    const html = await fetchPage();
    expect(html).toContain("No SSH");
    expect(html).toContain("Guest shell");
    expect(html).toContain("startHeartbeat");
    expect(html).toContain("new Worker");
    expect(html).toContain("wakeLock");
    // Backgrounding must not tear down the socket — only pagehide does.
    expect(html).toContain("sendImmediatePing");
    expect(html).toMatch(/visibilitychange[\s\S]*document\.hidden/);
  });

  it("emits a syntactically valid inline script", async () => {
    const script = inlineScript(await fetchPage());
    // `new Function` compiles without executing — a syntax error throws.
    expect(() => new Function(script)).not.toThrow();
  });

  it("only reaches for element ids that exist in the markup", async () => {
    const html = await fetchPage();
    const ids = [...html.matchAll(/\$\("([a-zA-Z0-9-]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    const missing = ids.filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  describe("serial-console framing helpers", () => {
    // Pull the helper block out of the emitted page and exercise it directly.
    // These four rules are what keep the engine from mis-reading the guest.
    async function helpers() {
      const script = inlineScript(await fetchPage());
      const seg = script.slice(
        script.indexOf("const MAX_LINE"),
        script.indexOf("// v86 engine:"),
      );
      return new Function(
        `${seg}\nreturn { MAX_LINE, shq, shSplit, emit, linesFit, textToB64, b64ToText };`,
      )() as {
        MAX_LINE: number;
        shq: (s: string) => string;
        shSplit: (m: string) => string;
        emit: (m: string) => string;
        linesFit: (s: string) => boolean;
        textToB64: (s: string) => string;
        b64ToText: (s: string) => string;
      };
    }

    it("never types a marker contiguously, so a TTY echo can't be mistaken for output", async () => {
      const { emit, shSplit } = await helpers();
      const marker = "__oma_rc_ab12_";
      expect(shSplit(marker)).toBe("'_''_oma_rc_ab12_'");
      expect(emit(marker)).not.toContain(marker);
    });

    it("single-quotes shell arguments POSIX-style", async () => {
      const { shq } = await helpers();
      expect(shq("/tmp/it's a file")).toBe("'/tmp/it'\\''s a file'");
    });

    it("keeps every emitted line inside the guest's line-discipline buffer", async () => {
      const { linesFit, MAX_LINE } = await helpers();
      expect(MAX_LINE).toBeLessThan(4096);
      expect(linesFit("a".repeat(MAX_LINE))).toBe(true);
      expect(linesFit("a".repeat(MAX_LINE + 1))).toBe(false);
      expect(linesFit(`short\n${"a".repeat(MAX_LINE + 1)}`)).toBe(false);
    });

    it("round-trips non-ASCII through base64 and survives invalid UTF-8", async () => {
      const { textToB64, b64ToText } = await helpers();
      expect(b64ToText(textToB64("héllo ✓\nline2"))).toBe("héllo ✓\nline2");
      // A lone 0xFF byte is not valid UTF-8; decoding must substitute rather
      // than throw, so reading a binary file returns something usable.
      expect(() => b64ToText("/w==")).not.toThrow();
    });
  });
});
