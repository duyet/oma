import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CronPresetPicker } from "./CronPresetPicker";
import { CRON_PRESETS, DEFAULT_CRON_VALUE } from "./cron-presets";

function renderPicker() {
  const onChange = vi.fn();
  render(
    <CronPresetPicker
      value={DEFAULT_CRON_VALUE}
      onChange={onChange}
      timezone="UTC"
      idPrefix="test"
    />,
  );
  return { onChange };
}

describe("<CronPresetPicker />", () => {
  it("gives every cadence an icon so the list is scannable before it's read", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Select cadence" }));

    for (const preset of CRON_PRESETS) {
      const option = await screen.findByRole("option", { name: preset.label });
      // Decorative: an svg per row, not an accessible name of its own.
      expect(option.querySelector("svg")).not.toBeNull();
    }
  });

  it("summarises the selected cadence in words alongside the raw expression", () => {
    renderPicker();
    const summary = screen.getByTestId("test-summary");
    expect(summary).toHaveTextContent("Every Monday at 9 AM");
    expect(summary).toHaveTextContent("(UTC)");
    expect(summary).toHaveTextContent("0 9 * * 1");
  });

  it("hands the parent a re-derived expression when the cadence changes", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Select cadence" }));
    await user.click(await screen.findByRole("option", { name: /Weekdays/ }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "weekdays", expression: "0 9 * * 1-5" }),
    );
  });
});
