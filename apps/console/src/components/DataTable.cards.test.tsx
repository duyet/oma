import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";

import { DataTable } from "./DataTable";

vi.mock("@/hooks/use-mobile", () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => true,
}));

type Item = { id: string; name: string };

const columns: ColumnDef<Item>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => row.original.name,
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

describe("DataTable cards", () => {
  it("renders renderCard instead of table rows on a phone viewport", () => {
    const Page = () => (
      <DataTable<Item>
        data={[{ id: "a", name: "Alpha" }]}
        getRowId={(r) => r.id}
        columns={columns}
        renderCard={(item) => <div>Card {item.name}</div>}
      />
    );

    render(
      <MemoryRouter initialEntries={["/test-table"]}>
        <Routes>
          <Route path="/test-table" element={<TestLayout />}>
            <Route index element={<Page />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Card Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).toBeNull();
    expect(screen.queryByRole("button", { name: /Columns/i })).toBeNull();
  });
});
