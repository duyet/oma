import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";

import { DataTable } from "./DataTable";

type Item = {
  id: string;
  name: string;
  score: number;
};

const items: Item[] = [
  { id: "a", name: "Alpha", score: 10 },
  { id: "b", name: "Bravo", score: 30 },
  { id: "c", name: "Charlie", score: 20 },
];

const columns: ColumnDef<Item>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => row.original.name,
  },
  {
    id: "score",
    accessorKey: "score",
    header: "Score",
    cell: ({ row }) => row.original.score,
  },
  {
    id: "actions",
    header: "",
    cell: () => "⋯",
    enableHiding: false,
    enableResizing: false,
  },
];

function TestLayout() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setSlot} data-testid="header-slot" />
      <Outlet context={{ pageHeaderSlot: slot }} />
    </>
  );
}

function renderTable(
  props: Partial<React.ComponentProps<typeof DataTable<Item>>> = {},
) {
  const Page = () => (
    <DataTable<Item>
      data={items}
      getRowId={(r) => r.id}
      columns={columns}
      {...props}
    />
  );

  return render(
    <MemoryRouter initialEntries={["/test-table"]}>
      <Routes>
        <Route path="/test-table" element={<TestLayout />}>
          <Route index element={<Page />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("DataTable", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("toggles column visibility from the Columns menu", async () => {
    renderTable();

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Columns/i }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /score/i }));

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("10")).not.toBeInTheDocument();
  });

  it("cycles sort asc → desc → clear on header click", async () => {
    renderTable();

    const headerSlot = screen.getByTestId("header-slot");
    const nameHeader = within(headerSlot).getByRole("button", { name: /Name/i });

    await userEvent.click(nameHeader);
    let rows = screen.getAllByRole("row").filter((r) => r.querySelector("td"));
    expect(rows[0]).toHaveTextContent("Alpha");

    await userEvent.click(nameHeader);
    rows = screen.getAllByRole("row").filter((r) => r.querySelector("td"));
    expect(rows[0]).toHaveTextContent("Charlie");

    await userEvent.click(nameHeader);
    rows = screen.getAllByRole("row").filter((r) => r.querySelector("td"));
    expect(rows[0]).toHaveTextContent("Alpha");
  });

  it("renders an expanded detail row when the chevron is clicked", async () => {
    renderTable({
      renderExpandedRow: (item) => <div>Detail for {item.name}</div>,
    });

    const expandBtn = screen.getAllByRole("button", { name: "Expand row" })[0];
    await userEvent.click(expandBtn);

    expect(screen.getByText("Detail for Alpha")).toBeInTheDocument();
  });

  it("exposes a column resize handle on sortable headers", () => {
    renderTable();
    const headerSlot = screen.getByTestId("header-slot");
    const handles = headerSlot.querySelectorAll(".cursor-col-resize");
    expect(handles.length).toBeGreaterThan(0);
  });

  it("shows a loaded-rows sort hint when hasMore is true and sorted", async () => {
    renderTable({ hasMore: true, onLoadMore: vi.fn() });

    const headerSlot = screen.getByTestId("header-slot");
    await userEvent.click(within(headerSlot).getByRole("button", { name: /Score/i }));

    expect(
      screen.getByText(/Sorted among loaded rows — load more to include the rest/i),
    ).toBeInTheDocument();
  });
});
