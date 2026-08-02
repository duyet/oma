import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { StackedAssembly } from "./StackedAssembly";

// The component fans out to a list endpoint per piece it draws. Every test
// stubs all of them (setup runs msw with onUnhandledRequest: "error"), then
// overrides just the ones under test — so a forgotten endpoint fails loudly
// instead of silently rendering an empty card.
const LIST_PATHS = [
  "/v1/agents",
  "/v1/model_cards",
  "/v1/skills",
  "/v1/environments",
  "/v1/vaults",
  "/v1/publications",
  "/v1/api_keys",
  "/v1/sessions",
  "/v1/memory_stores",
  "/v1/files",
];

function mockLists(overrides: Record<string, unknown[]> = {}) {
  server.use(
    ...LIST_PATHS.map((path) =>
      http.get(path, () => HttpResponse.json({ data: overrides[path] ?? [] })),
    ),
    ...["linear", "github", "slack"].map((p) =>
      http.get(`/v1/integrations/${p}/installations`, () =>
        HttpResponse.json({ data: [] }),
      ),
    ),
  );
}

function renderAssembly() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StackedAssembly />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<StackedAssembly />", () => {
  it("draws the four flow steps in configure → compose → run → reach order", async () => {
    mockLists();
    renderAssembly();

    // Steps are rendered as "1 · Configure" etc. Matching on a regex keeps
    // the assertion about the *flow*, not the separator glyph.
    const steps = await screen.findAllByText(
      /^[1-4] · (Configure|Compose|Run|Reach)$/,
    );
    // Dedupe: a collapsed step renders its label twice (desktop rail +
    // stacked-mobile full panel) — order is what this test guards.
    expect([...new Set(steps.map((s) => s.textContent))]).toEqual([
      "1 · Configure",
      "2 · Compose",
      "3 · Run",
      "4 · Reach",
    ]);
  });

  it("renders every piece as its own card, including the pieces the flow adds", async () => {
    mockLists();
    renderAssembly();

    // Guards the regression this redesign could most easily cause: dropping a
    // navigable card while rearranging the layout.
    for (const title of [
      "API key",
      "Model card",
      "Environment",
      "Keys (Vault)",
      "Memory",
      "Files",
      "Skills",
      "Agent",
      "Session",
      "Sandbox",
      "Channels",
      "Publications",
    ]) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
  });

  it("states the composition rule the flow can't show", async () => {
    mockLists();
    renderAssembly();

    // The whole point of the formula: MCP belongs to the agent, and env +
    // vaults belong to the session — neither of which the left-to-right flow
    // can express. Assert the operands, not just the presence of a box.
    //
    // Scoped by testid rather than text: "agent" legitimately appears twice —
    // as row 1's subject and as an operand of row 2 — so a text lookup is
    // ambiguous by construction.
    expect((await screen.findByTestId("formula-agent")).textContent).toBe(
      "agent=model + skills + mcp",
    );
    expect(screen.getByTestId("formula-session").textContent).toBe(
      "session=agent + env + vaults",
    );
  });

  it("keeps Skills with the Agent and Env + Vaults in Run, per the formula", async () => {
    mockLists();
    renderAssembly();

    const compose = (await screen.findByText("2 · Compose")).parentElement
      ?.parentElement;
    const run = screen.getByText("3 · Run").parentElement?.parentElement;
    expect(compose).toBeTruthy();
    expect(run).toBeTruthy();

    // `agent = model + skills + mcp` — Skills is agent config, so it sits in
    // step 2. getByText throws if it drifts back to step 1.
    expect(within(compose!).getByText("Skills")).toBeInTheDocument();
    expect(within(compose!).queryByText("Keys (Vault)")).toBeNull();

    // `session = agent + env + vaults` — Environment and Vaults are
    // session-scoped (`environment_id` / `vault_ids` on SessionMeta), so both
    // sit in step 3 with the Session, not back in Configure.
    expect(within(run!).getByText("Environment")).toBeInTheDocument();
    expect(within(run!).getByText("Keys (Vault)")).toBeInTheDocument();
  });

  it("pairs Environment and Vaults in one row above the Session", async () => {
    mockLists();
    renderAssembly();

    const envCard = (await screen.findByText("Environment")).closest("button");
    const vaultCard = screen.getByText("Keys (Vault)").closest("button");
    expect(envCard).not.toBeNull();
    expect(vaultCard).not.toBeNull();

    const row = envCard!.closest(".items-stretch");
    expect(row).not.toBeNull();
    expect(vaultCard!.closest(".items-stretch")).toBe(row);
  });

  it("pairs Memory and Files in one row", async () => {
    mockLists();
    renderAssembly();

    const memoryCard = (await screen.findByText("Memory")).closest("button");
    const filesCard = screen.getByText("Files").closest("button");
    expect(memoryCard).not.toBeNull();
    expect(filesCard).not.toBeNull();

    // Asserting a non-null shared row ancestor (rather than comparing two
    // parent chains) keeps this from passing vacuously when lookups miss.
    const row = memoryCard!.closest(".items-stretch");
    expect(row).not.toBeNull();
    expect(filesCard!.closest(".items-stretch")).toBe(row);
  });

  it("has no MCP card — MCP is a field inside the agent, not its own resource", async () => {
    mockLists();
    renderAssembly();

    // Wait for real content before asserting an absence, or this passes
    // against a still-loading tree.
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.queryByText(/MCP/)).not.toBeInTheDocument();
  });

  it("shows live instance names as badges once resources exist", async () => {
    mockLists({
      "/v1/agents": [{ id: "agent_1", name: "Support bot" }],
      "/v1/api_keys": [{ id: "key_1", name: "CI key" }],
    });
    renderAssembly();

    expect(await screen.findByText("Support bot")).toBeInTheDocument();
    expect(await screen.findByText("CI key")).toBeInTheDocument();
  });

  it("counts only Configure + Compose toward the required-step tally", async () => {
    // An agent exists but there's no model card / environment, so exactly one
    // of the two required steps is done. Reach/Run must not inflate this.
    mockLists({ "/v1/agents": [{ id: "agent_1", name: "Support bot" }] });
    renderAssembly();

    expect(
      await screen.findByText("1 of 2 required steps complete"),
    ).toBeInTheDocument();
  });

  it("describes the Sandbox by the providers its environments actually use", async () => {
    mockLists({
      "/v1/environments": [
        { id: "env_1", name: "default", status: "ready", config: {} },
      ],
    });
    renderAssembly();

    // config.{} → the "cloud" default → friendly provider label, surfaced as
    // the RUN step's description rather than a bare badge.
    await waitFor(() =>
      // Provider names moved out of the copy into the avatar-group of
      // marks; the description stays generic and a coin renders per
      // provider id. The title carries the id plus a liveness suffix —
      // `cloud` when the provider reports healthy, `cloud (idle)` when it
      // doesn't — so match the id and stay agnostic about health, which
      // isn't what this test is about.
      expect(screen.getByTitle(/^cloud( \(idle\))?$/)).toBeInTheDocument(),
    );
  });
});
