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

  it("defaults to OMA Standard and omits _oma.harness for the server default", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "OMA Standard" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("harness").textContent).toBe("default");
    // formToConfig suppresses _oma when harness is "default".
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toBeUndefined();
    expect(screen.getByText(/Built-in toolset/i)).toBeTruthy();
  });

  it("offers OMA Standard and Claude Agent SDK as first-class cloud harnesses", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "OMA Standard" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Claude Agent SDK" })).toBeTruthy();
    // Local ACP is chosen via Agent runtime → Local, not a harness card.
    expect(screen.queryByRole("radio", { name: "ACP Runtime" })).toBeNull();
    for (const gone of ["Long-running", "Poolside"]) {
      expect(screen.queryByRole("radio", { name: gone })).toBeNull();
    }
  });

  it("writes claude-agent-sdk when that card is selected", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Claude Agent SDK" }));
    expect(screen.getByTestId("harness").textContent).toBe("claude-agent-sdk");
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toEqual({
      harness: "claude-agent-sdk",
    });
    expect(screen.getByText(/Self-host Node only/i)).toBeTruthy();
  });

  it("writes the browser environment as the agent's default, leaving the harness alone", () => {
    render(<Harness initial={{ browserEnvId: "env_browser" }} />);

    const config = JSON.parse(screen.getByTestId("config").textContent!);
    expect(config.metadata).toEqual({
      default_environment_id: "env_browser",
      runtime_kind: "browser",
    });
    // Browser is a sandbox provider, not a harness — Standard stays default.
    expect(config._oma).toBeUndefined();
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
    expect(screen.getByRole("radio", { name: "OMA Standard" })).toBeTruthy();
  });

  it("the Local agent-runtime mode switches the form to the local machine flow", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("radio", { name: /Local/ }));
    // Local mode replaces the cloud harness block with the connect-a-machine state.
    expect(screen.queryByRole("radio", { name: "OMA Standard" })).toBeNull();
    expect(screen.getByText(/No runtimes registered/i)).toBeTruthy();
  });
});
