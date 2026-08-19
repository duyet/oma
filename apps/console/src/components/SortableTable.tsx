import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";

import { cn, rowActivateKeyDown } from "@/lib/utils";

export type SortableTableColumn<T> = {
  id: string;
  header: ReactNode;
  accessor?: (row: T) => string | number | null | undefined;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  className?: string;
};

export interface SortableTableProps<T> {
  columns: SortableTableColumn<T>[];
  data: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  renderExpandedRow?: (row: T) => ReactNode;
  getRowCanExpand?: (row: T) => boolean;
  className?: string;
  dense?: boolean;
}

type SortDir = "asc" | "desc";

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Lightweight client-sort table for embedded surfaces without DataTable chrome. */
export function SortableTable<T>({
  columns,
  data,
  getRowId,
  onRowClick,
  renderExpandedRow,
  getRowCanExpand,
  className,
  dense,
}: SortableTableProps<T>) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const sorted = useMemo(() => {
    if (!sortCol) return data;
    const col = columns.find((c) => c.id === sortCol);
    if (!col?.accessor) return data;
    const accessor = col.accessor;
    return [...data].sort((a, b) => {
      const cmp = compareValues(accessor(a), accessor(b));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [columns, data, sortCol, sortDir]);

  const toggleSort = (col: SortableTableColumn<T>) => {
    if (!col.accessor) return;
    if (sortCol !== col.id) {
      setSortCol(col.id);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    setSortCol(null);
    setSortDir("asc");
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const showExpand = !!renderExpandedRow;
  const colCount = columns.length + (showExpand ? 1 : 0);
  const cellPad = dense ? "px-3 py-2" : "px-4 py-2.5";

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-bg-surface/40 text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
            {showExpand ? <th className="w-9 px-2 py-2.5" aria-hidden /> : null}
            {columns.map((col) => {
              const sortable = !!col.accessor;
              const active = sortCol === col.id;
              const Icon =
                !sortable
                  ? null
                  : active && sortDir === "asc"
                    ? ChevronUpIcon
                    : active && sortDir === "desc"
                      ? ChevronDownIcon
                      : ChevronsUpDownIcon;
              return (
                <th
                  key={col.id}
                  className={cn(
                    "pb-2.5 font-medium whitespace-nowrap",
                    cellPad,
                    col.align === "right" ? "text-right" : "text-left",
                    col.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1 hover:text-fg transition-colors",
                        col.align === "right" && "ml-auto",
                      )}
                      onClick={() => toggleSort(col)}
                    >
                      {col.header}
                      {Icon ? (
                        <Icon className={cn("size-3.5 shrink-0", !active && "opacity-40")} />
                      ) : null}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const id = getRowId(row);
            const canExpand = showExpand && (getRowCanExpand ? getRowCanExpand(row) : true);
            const isExpanded = canExpand && expanded.has(id);
            return (
              <Fragment key={id}>
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick ? rowActivateKeyDown(() => onRowClick(row)) : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? "button" : undefined}
                  className={cn(
                    "border-t border-border transition-colors",
                    onRowClick && "cursor-pointer hover:bg-bg-surface/40",
                  )}
                >
                  {showExpand ? (
                    <td className="w-9 px-2 py-2.5">
                      {canExpand ? (
                        <button
                          type="button"
                          aria-label={isExpanded ? "Collapse row" : "Expand row"}
                          aria-expanded={isExpanded}
                          className="inline-flex items-center justify-center rounded p-0.5 text-fg-muted hover:text-fg hover:bg-bg-surface"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(id);
                          }}
                        >
                          <ChevronRightIcon
                            className={cn("size-4 transition-transform", isExpanded && "rotate-90")}
                          />
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        cellPad,
                        col.align === "right" ? "text-right tabular-nums" : "text-left",
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
                {isExpanded && renderExpandedRow ? (
                  <tr className="border-t border-border/50">
                    <td colSpan={colCount} className="px-4 py-3 bg-muted/30">
                      <div className="rounded-lg border border-border/60 bg-bg/80 px-4 py-3">
                        {renderExpandedRow(row)}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
