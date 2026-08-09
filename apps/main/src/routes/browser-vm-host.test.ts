import { describe, it, expect } from "vitest";
import browserVmHostRoutes, {
  classifyV86Media,
  isLegacyDefaultImage,
  proxiedAssetUrl,
} from "./browser-vm-host";

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
    // When re-pair fails (e.g. KV write budget), fall back to a previously
    // stored token instead of bricking a still-valid pairing.
    expect(html).toContain("using stored token");
    expect(html).toContain("registered (stored token; re-pair failed)");
  });

  it("ships serial-ready public defaults (bzimage), not the non-serial linux.iso", async () => {
    const html = await fetchPage();
    // Without these, a freshly paired tab pairs but fails every op with
    // "no VM image configured". Defaults must be CORP-safe (proxy or CDN).
    expect(html).toContain("DEFAULT_V86_LIB");
    expect(html).toContain("cdn.jsdelivr.net/npm/v86@");
    expect(html).toContain("DEFAULT_V86_IMAGE");
    // Serial-ready buildroot kernel used by v86/examples/serial.html.
    expect(html).toContain("buildroot-bzimage68.bin");
    expect(html).toContain("i.copy.sh");
    // Same-origin asset proxy so COEP require-corp can load i.copy.sh.
    expect(html).toContain("/sandbox-tab/asset?url=");
    // The old default never exposes a serial shell — must not remain the default.
    expect(html).not.toMatch(/DEFAULT_V86_IMAGE\s*=\s*"[^"]*linux\.iso"/);
    expect(html).toContain("DEFAULT_V86_BIOS");
    expect(html).toContain("bios/seabios.bin");
    // Boot path must configure bzimage + cmdline, not only cdrom.
    expect(html).toContain("opts.bzimage");
    expect(html).toContain("DEFAULT_BZIMAGE_CMDLINE");
    expect(html).toContain("console=ttyS0");
  });

  it("surfaces image diagnostics and an in-tab self-test control", async () => {
    const html = await fetchPage();
    for (const id of [
      "image-diag",
      "img-url",
      "img-kind",
      "img-size",
      "img-dl",
      "img-cache",
      "img-phase",
      "btn-self-test",
      "self-test-status",
      "btn-show-setup",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("runSelfTest");
    expect(html).toContain("self-test: exec true");
    expect(html).toContain("oma-self-test-ok");
    expect(html).toContain("download-progress");
    expect(html).toContain("setBootPhase");
    // 180s shell wait still fails loud.
    expect(html).toContain("VM did not reach a shell within 180s");
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

  describe("classifyV86Media (exported pure helper)", () => {
    it("classifies serial-ready bzimage kernels, not as initial_state", () => {
      expect(classifyV86Media("https://i.copy.sh/buildroot-bzimage68.bin")).toBe("bzimage");
      expect(classifyV86Media("https://i.copy.sh/buildroot-bzimage.bin")).toBe("bzimage");
      expect(classifyV86Media("/sandbox-tab/asset?url=https%3A%2F%2Fi.copy.sh%2Fbuildroot-bzimage68.bin"))
        .toBe("bzimage");
      expect(classifyV86Media("https://example.com/vmlinuz")).toBe("bzimage");
      // Bare .bin must NOT be treated as a save-state (the pre-fix bug).
      expect(classifyV86Media("https://cdn.example.com/guest.bin")).toBe("bzimage");
    });

    it("classifies iso, disk, and explicit state media", () => {
      expect(classifyV86Media("https://cdn.jsdelivr.net/gh/copy/images@master/linux.iso")).toBe("iso");
      expect(classifyV86Media("https://example.com/disk.img")).toBe("hda");
      expect(classifyV86Media("https://example.com/vm-state.bin.zst")).toBe("state");
      expect(classifyV86Media("https://example.com/initial_state.bin")).toBe("state");
      expect(classifyV86Media("https://example.com/foo/v86state/bar")).toBe("state");
    });
  });

  describe("legacy default migration helpers", () => {
    it("detects the pre-fix linux.iso default", () => {
      expect(isLegacyDefaultImage(
        "https://cdn.jsdelivr.net/gh/copy/images@master/linux.iso",
      )).toBe(true);
      expect(isLegacyDefaultImage(
        "https://i.copy.sh/buildroot-bzimage68.bin",
      )).toBe(false);
    });

    it("builds a same-origin asset proxy URL", () => {
      const u = proxiedAssetUrl("https://i.copy.sh/buildroot-bzimage68.bin");
      expect(u).toBe(
        "/sandbox-tab/asset?url=" +
          encodeURIComponent("https://i.copy.sh/buildroot-bzimage68.bin"),
      );
    });
  });

  describe("asset proxy", () => {
    it("rejects missing, invalid, non-https, and non-allowlisted hosts", async () => {
      expect((await browserVmHostRoutes.request("/asset")).status).toBe(400);
      expect((await browserVmHostRoutes.request("/asset?url=not-a-url")).status).toBe(400);
      expect(
        (await browserVmHostRoutes.request("/asset?url=" + encodeURIComponent("http://i.copy.sh/x"))).status,
      ).toBe(400);
      expect(
        (await browserVmHostRoutes.request(
          "/asset?url=" + encodeURIComponent("https://evil.example/x.bin"),
        )).status,
      ).toBe(403);
    });
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
        `${seg}\nreturn { MAX_LINE, shq, shSplit, emit, linesFit, textToB64, b64ToText, classifyV86Media, isLegacyDefaultImage, buildV86BootOptions, DEFAULT_BZIMAGE_CMDLINE };`,
      )() as {
        MAX_LINE: number;
        shq: (s: string) => string;
        shSplit: (m: string) => string;
        emit: (m: string) => string;
        linesFit: (s: string) => boolean;
        textToB64: (s: string) => string;
        b64ToText: (s: string) => string;
        classifyV86Media: (url: string) => string;
        isLegacyDefaultImage: (url: string) => boolean;
        buildV86BootOptions: (
          imageUrl: string,
          libBase: string,
          biosUrl: string,
          vgaBiosUrl: string,
        ) => Record<string, unknown>;
        DEFAULT_BZIMAGE_CMDLINE: string;
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

    it("page-side media classifier matches exported helper and builds bzimage opts", async () => {
      // Minimal document stub so buildV86BootOptions can resolve screen_container.
      const g = globalThis as typeof globalThis & { document?: { getElementById: () => null } };
      const prev = g.document;
      g.document = { getElementById: () => null };
      try {
        const h = await helpers();
        expect(h.classifyV86Media("https://i.copy.sh/buildroot-bzimage68.bin")).toBe("bzimage");
        expect(h.classifyV86Media("https://cdn.example/x.bin")).toBe("bzimage");
        expect(h.classifyV86Media("https://cdn.example/s.bin.zst")).toBe("state");
        expect(h.isLegacyDefaultImage(
          "https://cdn.jsdelivr.net/gh/copy/images@master/linux.iso",
        )).toBe(true);

        const bz = h.buildV86BootOptions(
          "https://i.copy.sh/buildroot-bzimage68.bin",
          "https://cdn.jsdelivr.net/npm/v86@0.5.44/build/",
          "https://bios",
          "https://vga",
        );
        expect(bz.bzimage).toEqual({
          url: "https://i.copy.sh/buildroot-bzimage68.bin",
          async: false,
        });
        expect(bz.cmdline).toBe(h.DEFAULT_BZIMAGE_CMDLINE);
        expect(bz.filesystem).toEqual({});
        expect(bz.initial_state).toBeUndefined();
        expect(bz.cdrom).toBeUndefined();
        expect(bz.media_kind).toBe("bzimage");

        // A .bin must NOT become initial_state.
        const bare = h.buildV86BootOptions(
          "https://cdn.example/kernel.bin",
          "https://cdn/build/",
          "https://bios",
          "https://vga",
        );
        expect(bare.initial_state).toBeUndefined();
        expect(bare.bzimage).toBeTruthy();

        const state = h.buildV86BootOptions(
          "https://cdn.example/vm-state.bin.zst",
          "https://cdn/build/",
          "https://bios",
          "https://vga",
        );
        expect(state.initial_state).toEqual({ url: "https://cdn.example/vm-state.bin.zst" });
        expect(state.bzimage).toBeUndefined();

        const iso = h.buildV86BootOptions(
          "https://cdn.example/linux.iso",
          "https://cdn/build/",
          "https://bios",
          "https://vga",
        );
        expect(iso.cdrom).toEqual({ url: "https://cdn.example/linux.iso" });
        expect(iso.bzimage).toBeUndefined();
      } finally {
        if (prev === undefined) delete g.document;
        else g.document = prev;
      }
    });
  });
});
