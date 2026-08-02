// Drift guard for the vendored OpenShell client. The proto is the one piece
// of the copy where divergence is silent AND corrupting (a field-number skew
// makes the gateway mis-parse), so assert it stays byte-identical to the
// source of truth in packages/sandbox. Read as text — the CLI must never
// import @duyet/oma-sandbox (private package, never published).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OPENSHELL_PROTO } from "./openshell-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const adapterPath = join(here, "../../../../sandbox/src/adapters/openshell.ts");

function extractAdapterProto(): string {
  const src = readFileSync(adapterPath, "utf-8");
  const decl = src.indexOf("const OPENSHELL_PROTO = `");
  expect(decl).toBeGreaterThan(-1);
  const start = src.indexOf("`", decl);
  const end = src.indexOf("`;", start + 1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start + 1, end);
}

describe("vendored OpenShell proto", () => {
  it("stays byte-identical to packages/sandbox/src/adapters/openshell.ts", () => {
    expect(OPENSHELL_PROTO).toBe(extractAdapterProto());
  });
});
