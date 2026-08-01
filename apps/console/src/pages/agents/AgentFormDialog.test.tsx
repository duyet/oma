import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BasicTab, INITIAL_FORM, formToConfig, type FormState } from "./AgentFormDialog";

function Harness({ initial }: { initial?: Partial<FormState> }) {
  const [form, setForm] = useState<FormState>({ ...INITIAL_FORM, ...initial });
  return (
    <>
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
    </>
  );
}

describe("<BasicTab /> harness picker", () => {
  it("defaults to Standard and emits no _oma.harness", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("harness").textContent).toBe("default");
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toBeUndefined();
  });

  it("selecting a harness card writes the same form value the select wrote", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("radio", { name: "Long-running" }));
    expect(screen.getByTestId("harness").textContent).toBe("long-running");
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toEqual({
      harness: "long-running",
    });
  });

  it("explains how the Claude Agent SDK harness applies the per-agent model", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByText(/applies the per-agent model/i)).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Claude Agent SDK" }));
    expect(screen.getByText(/applies the per-agent model/i)).toBeTruthy();
  });

  it("selects the poolside harness and surfaces its API-key requirement", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByText(/POOLSIDE_API_KEY/)).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Poolside" }));
    expect(screen.getByTestId("harness").textContent).toBe("poolside");
    expect(JSON.parse(screen.getByTestId("config").textContent!)._oma).toEqual({
      harness: "poolside",
    });
    expect(screen.getByText(/POOLSIDE_API_KEY/)).toBeTruthy();
  });

  it("the local runtime card switches the form to the Local machine flow", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("radio", { name: "ACP local runtime" }));
    // Local mode replaces the cloud block with the connect-a-machine state.
    expect(screen.queryByRole("radio", { name: "Standard" })).toBeNull();
    expect(screen.getByText(/No runtimes registered/i)).toBeTruthy();
  });
});
