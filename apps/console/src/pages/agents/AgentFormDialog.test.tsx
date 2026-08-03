import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { BasicTab, INITIAL_FORM, formToConfig, type FormState } from "./AgentFormDialog";

/** BasicTab loads the environment list for the Browser runtime mode, so it
 *  needs a query client the same way the session dialogs' tests do. */
function Harness({ initial }: { initial?: Partial<FormState> }) {
  const [form, setForm] = useState<FormState>({ ...INITIAL_FORM, ...initial });
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BasicTab
        form={form}
        setForm={setForm as never}
        createError=""
        inputCls="input"
        modelCards={[]}
        runtimes={[]}
        selectedCardId=""
      />
      <output data-testid="harness">{form.harness}</output>
      <output data-testid="config">{JSON.stringify(formToConfig(form))}</output>
    </QueryClientProvider>
  );
}

describe("<BasicTab /> harness picker", () => {
  beforeEach(() => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({
          data: [{ id: "env_browser", name: "Browser VM", config: { sandbox_provider: "browser-vm" } }],
        }),
      ),
    );
  });

  it("defaults to the Claude Agent SDK harness and writes it to the config", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "Claude Agent SDK" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("harness").textContent).toBe("claude-agent-sdk");
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toEqual({
      harness: "claude-agent-sdk",
    });
    expect(screen.getByText(/applies the per-agent model/i)).toBeTruthy();
  });

  it("offers only Claude Agent SDK and the local ACP Runtime", () => {
    render(<Harness />);
    for (const gone of ["Standard", "Long-running", "Poolside"]) {
      expect(screen.queryByRole("radio", { name: gone })).toBeNull();
    }
    expect(screen.getByRole("radio", { name: "ACP Runtime" })).toBeTruthy();
  });

  it("writes the browser environment as the agent's default, leaving the harness alone", () => {
    render(<Harness initial={{ browserEnvId: "env_browser" }} />);

    const config = JSON.parse(screen.getByTestId("config").textContent!);
    expect(config.metadata).toEqual({
      default_environment_id: "env_browser",
      runtime_kind: "browser",
    });
    // Browser is a sandbox provider, not a harness — the cloud harness stays.
    expect(config._oma).toEqual({ harness: "claude-agent-sdk" });
  });

  it("keeps an existing agent's unsupported harness instead of rewriting it", () => {
    render(<Harness initial={{ harness: "poolside" }} />);

    const legacy = screen.getByRole("radio", { name: "Poolside" });
    expect(legacy).toHaveAttribute("aria-checked", "true");
    expect(legacy).toBeDisabled();
    expect(screen.getByTestId("harness").textContent).toBe("poolside");
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toEqual({
      harness: "poolside",
    });
  });

  it("offers Browser as a third runtime mode alongside Cloud and Local", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const browser = screen.getByRole("radio", { name: /Browser/ });
    await user.click(browser);
    expect(browser).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Cloud/ })).toHaveAttribute("aria-checked", "false");
    // The model + harness still apply — only the sandbox moves to the tab.
    expect(screen.getByRole("radio", { name: "Claude Agent SDK" })).toBeTruthy();
  });

  it("the local runtime card switches the form to the Local machine flow", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("radio", { name: "ACP Runtime" }));
    // Local mode replaces the cloud block with the connect-a-machine state.
    expect(screen.queryByRole("radio", { name: "Claude Agent SDK" })).toBeNull();
    expect(screen.getByText(/No runtimes registered/i)).toBeTruthy();
  });
});
