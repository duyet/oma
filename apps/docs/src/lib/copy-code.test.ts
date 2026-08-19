import { describe, expect, it } from "vitest";
import {
  EC_NEWLINE_PLACEHOLDER,
  codeFromEcLineTexts,
  copyFromEcLinesJsModule,
  decodeCopyAttribute,
} from "./copy-code";

describe("docs copy-button newlines", () => {
  it("decodes Expressive Code's U+007F newline stand-in", () => {
    const attr = `git clone https://github.com/duyet/oma.git${EC_NEWLINE_PLACEHOLDER}cd oma`;
    expect(decodeCopyAttribute(attr)).toBe(
      "git clone https://github.com/duyet/oma.git\ncd oma",
    );
  });

  it("joins .ec-line texts with real newlines (empty lines kept)", () => {
    expect(
      codeFromEcLineTexts([
        "echo \"BETTER_AUTH_SECRET=$(openssl rand -hex 32)\" >> .env",
        "echo \"PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)\" >> .env",
      ]),
    ).toBe(
      "echo \"BETTER_AUTH_SECRET=$(openssl rand -hex 32)\" >> .env\n" +
        "echo \"PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)\" >> .env",
    );
    expect(codeFromEcLineTexts(["a", "", "b"])).toBe("a\n\nb");
  });

  it("strips layout newlines inside a single line's textContent", () => {
    expect(codeFromEcLineTexts(["git clone repo\n", "cd oma\n"])).toBe(
      "git clone repo\ncd oma",
    );
  });

  it("injects a capture-phase patcher that rebuilds data-code from .ec-line", () => {
    expect(copyFromEcLinesJsModule).toContain(".ec-line .code");
    expect(copyFromEcLinesJsModule).toContain('setAttribute("data-code"');
    expect(copyFromEcLinesJsModule).toContain(", true)");
    expect(copyFromEcLinesJsModule).toContain("closest(\".expressive-code .copy button\")");
  });
});
