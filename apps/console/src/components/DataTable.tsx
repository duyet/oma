import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  EyeOffIcon,
  SearchIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, rowActivateKeyDown } from "@/lib/utils";
import { useLocation } from "react-router";

/** Compact label/value grid for expandable row detail panels. */
export function ExpandedDetail({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
      {rows.map(({ label, value }) => (
        <div key={label}>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            {label}
          </div>
          <div className="text-foreground mt-0.5 break-words">{value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * DataTable — list page chrome with a frozen, column-aligned header.
 *
 * Built on TanStack Table (headless) + shadcn `<Table>` primitives.
 * Used when a page wants:
 *
 *   - A header pinned outside the scroll container (Excel-style frozen
 *     first row, never moves as the body scrolls).
 *   - A toolbar with a server-side global search box, page-specific
 *     filter chips, and a "Columns" dropdown for show/hide.
 *   - IntersectionObserver-driven load-more for infinite scroll (same
 *     API as ListPage — `hasMore` / `loadingMore` / `onLoadMore`).
 *   - Client-side sort + column resize on **loaded rows only** — when
 *     `hasMore` is true, a toolbar hint warns that unloaded pages aren't
 *     included. Persisted per route in localStorage (`dt-sort`, `dt-sizes`).
 *   - Optional expandable detail rows via `renderExpandedRow`.
 *
 * Structured filters (enum, time bucket) belong in the toolbar `filters`
 * slot, wired to real server query params — not per-column filter popovers.
 */
export interface DataTableProps<T> {
  title?: ReactNode;
  subtitle?: ReactNode;
  createLabel?: string;
  onCreate?: () => void;
  headerActions?: ReactNode;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  filters?: ReactNode;
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId: (item: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptySubtitle?: ReactNode;
  emptyAction?: ReactNode;
  emptyKind?: EmptyStateKind;
  emptyIcon?: ReactNode;
  error?: string | null;
  onRetry?: () => void;
  errorTitle?: string;
  onRowClick?: (item: T) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  renderExpandedRow?: (item: T) => ReactNode;
  getRowCanExpand?: (item: T) => boolean;
  children?: ReactNode;
}

const EXPAND_COLUMN_ID = "_expand";

function isActionColumn<T>(col: ColumnDef<T, unknown>): boolean {
  const id = col.id ?? ("accessorKey" in col ? String(col.accessorKey) : "");
  return id === "actions" || col.enableResizing === false;
}

function prepareColumns<T>(
  columns: ColumnDef<T, unknown>[],
  withExpand: boolean,
): ColumnDef<T, unknown>[] {
  const normalized = columns.map((col) => {
    const hasAccessor =
      ("accessorKey" in col && col.accessorKey != null) ||
      ("accessorFn" in col && typeof col.accessorFn === "function");
    const action = isActionColumn(col);
    return {
      ...col,
      enableSorting: col.enableSorting ?? (hasAccessor && !action),
      enableResizing: col.enableResizing ?? !action,
    };
  });
  if (!withExpand) return normalized;
  return [
    {
      id: EXPAND_COLUMN_ID,
      header: () => null,
      cell: () => null,
      enableHiding: false,
      enableSorting: false,
      enableResizing: false,
      size: 36,
    },
    ...normalized,
  ];
}

function cycleColumnSort<T>(
  column: ReturnType<TanstackTable<T>["getAllColumns"]>[number],
) {
  const sorted = column.getIsSorted();
  if (!sorted) column.toggleSorting(false);
  else if (sorted === "asc") column.toggleSorting(true);
  else column.clearSorting();
}

function SortableHeader<T>({
  column,
  children,
}: {
  column: ReturnType<TanstackTable<T>["getAllColumns"]>[number];
  children: ReactNode;
}) {
  if (!column.getCanSort()) {
    return <span className="font-medium">{children}</span>;
  }
  const sorted = column.getIsSorted();
  const Icon =
    sorted === "asc"
      ? ChevronUpIcon
      : sorted === "desc"
        ? ChevronDownIcon
        : ChevronsUpDownIcon;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-medium hover:text-foreground transition-colors -ml-1 px-1 rounded"
      onClick={() => cycleColumnSort(column)}
    >
      {children}
      <Icon className={cn("size-3.5 shrink-0", !sorted && "opacity-40")} />
    </button>
  );
}

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function DataTable<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  headerActions,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  filters,
  columns,
  data,
  getRowId,
  loading,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  emptyAction,
  emptyKind,
  emptyIcon,
  error,
  onRetry,
  errorTitle = "Couldn't load data",
  onRowClick,
  hasMore,
  onLoadMore,
  loadingMore,
  renderExpandedRow,
  getRowCanExpand,
  children,
}: DataTableProps<T>) {
  const { pathname } = useLocation();
  const colsStorageKey = `dt-cols:${pathname}`;
  const sortStorageKey = `dt-sort:${pathname}`;
  const sizesStorageKey = `dt-sizes:${pathname}`;

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() =>
    readJsonStorage(colsStorageKey, {}),
  );
  const [sorting, setSorting] = useState<SortingState>(() =>
    readJsonStorage(sortStorageKey, []),
  );
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() =>
    readJsonStorage(sizesStorageKey, {}),
  );
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      localStorage.setItem(colsStorageKey, JSON.stringify(columnVisibility));
    } catch {
      /* ignore */
    }
  }, [colsStorageKey, columnVisibility]);

  useEffect(() => {
    try {
      localStorage.setItem(sortStorageKey, JSON.stringify(sorting));
    } catch {
      /* ignore */
    }
  }, [sortStorageKey, sorting]);

  useEffect(() => {
    try {
      localStorage.setItem(sizesStorageKey, JSON.stringify(columnSizing));
    } catch {
      /* ignore */
    }
  }, [sizesStorageKey, columnSizing]);

  const tableColumns = useMemo(
    () => prepareColumns(columns, !!renderExpandedRow),
    [columns, renderExpandedRow],
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { columnVisibility, sorting, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 60, size: 150 },
  });

  const showCreate = !!onCreate && !!createLabel;
  const showSortHint = !!hasMore && sorting.length > 0;

  const toolbar = (
    <>
      {headerActions}
      {showCreate && <Button onClick={onCreate}>{createLabel}</Button>}
      {filters}
      <div className="flex-1" />
      {showSortHint ? (
        <p className="hidden sm:block text-[11px] text-muted-foreground shrink-0 max-w-[14rem] leading-tight">
          Sorted among loaded rows — load more to include the rest
        </p>
      ) : null}
      {onSearchChange && (
        <InputGroup className="w-full sm:w-64 shrink-0">
          <InputGroupAddon>
            <SearchIcon className="size-3.5 opacity-50" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={searchValue ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder ?? "Search..."}
            autoComplete="off"
            name="oma-list-search"
          />
        </InputGroup>
      )}
      <ColumnVisibilityMenu table={table} />
    </>
  );

  const filteredRows = table.getRowModel().rows;
  const hasRows = filteredRows.length > 0;
  const hasError = !loading && !hasRows && !!error;
  const isEmpty = !loading && !hasRows && !error;
  const visibleColumns = table.getAllColumns().filter((c) => c.getIsVisible());
  const visibleColumnCount = visibleColumns.length;

  const colgroup = (
    <colgroup>
      {visibleColumns.map((col) => (
        <col key={col.id} style={{ width: `${col.getSize()}px` }} />
      ))}
    </colgroup>
  );

  const frozenHeader = !loading && hasRows ? (
    <div id="dt-header-scroll" className="overflow-x-hidden">
      <table className="w-full table-fixed text-muted-foreground">
        {colgroup}
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="relative h-9 px-3 text-left text-xs font-medium align-middle whitespace-nowrap"
                  style={{ width: header.getSize() }}
                >
                  {header.isPlaceholder ? null : header.column.id === EXPAND_COLUMN_ID ? null : (
                    <SortableHeader column={header.column}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </SortableHeader>
                  )}
                  {header.column.getCanResize() ? (
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        "absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none",
                        header.column.getIsResizing()
                          ? "bg-brand opacity-80"
                          : "opacity-0 hover:opacity-100 hover:bg-border",
                      )}
                      aria-hidden
                    />
                  ) : null}
                </th>
              ))}
            </tr>
          ))}
        </thead>
      </table>
    </div>
  ) : undefined;

  useEffect(() => {
    const body = document.getElementById("dt-body-scroll");
    const header = document.getElementById("dt-header-scroll");
    if (!body || !header) return;
    const onScroll = () => {
      header.scrollLeft = body.scrollLeft;
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [loading, isEmpty, hasError]);

  const toggleExpand = (rowId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  return (
    <>
      <PageHeader toolbar={toolbar} tableHeader={frozenHeader} title={title} subtitle={subtitle} />

      {loading ? (
        <SkeletonRows colSpan={visibleColumnCount} />
      ) : hasError ? (
        <div className="py-4">
          <EmptyState
            title={errorTitle}
            body={error}
            action={onRetry && <Button onClick={onRetry}>Retry</Button>}
            icon={<TriangleAlertIcon className="text-destructive" />}
            tone="danger"
            size="lg"
          />
        </div>
      ) : isEmpty ? (
        <div className="py-4">
          <EmptyState
            title={emptyTitle}
            body={emptySubtitle}
            action={emptyAction}
            kind={emptyKind}
            icon={emptyIcon}
            size="lg"
          />
        </div>
      ) : (
        <div id="dt-body-scroll" className="pb-4 overflow-x-auto">
          <table className="w-full table-fixed border-separate border-spacing-y-1.5">
            {colgroup}
            <tbody>
              {filteredRows.map((row) => {
                const cells = row.getVisibleCells();
                const canExpand =
                  !!renderExpandedRow &&
                  (getRowCanExpand ? getRowCanExpand(row.original) : true);
                const isExpanded = canExpand && expandedRows.has(row.id);

                return (
                  <Fragment key={row.id}>
                    <tr
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                      onKeyDown={
                        onRowClick
                          ? rowActivateKeyDown(() => onRowClick(row.original))
                          : undefined
                      }
                      tabIndex={onRowClick ? 0 : undefined}
                      role={onRowClick ? "button" : undefined}
                      className={cn(
                        "bg-muted/60 hover:bg-muted transition-colors",
                        "[&>td]:bg-transparent [&>td]:px-3 [&>td]:py-2 [&>td]:align-middle [&>td]:text-sm",
                        "[&>td:first-child]:rounded-l-lg",
                        "[&>td:last-child]:rounded-r-lg",
                        onRowClick && "cursor-pointer",
                      )}
                    >
                      {cells.map((cell) => {
                        if (cell.column.id === EXPAND_COLUMN_ID) {
                          return (
                            <td key={cell.id} className="w-9 !px-1">
                              {canExpand ? (
                                <button
                                  type="button"
                                  aria-label={isExpanded ? "Collapse row" : "Expand row"}
                                  aria-expanded={isExpanded}
                                  className="inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleExpand(row.id);
                                  }}
                                >
                                  <ChevronRightIcon
                                    className={cn(
                                      "size-4 transition-transform",
                                      isExpanded && "rotate-90",
                                    )}
                                  />
                                </button>
                              ) : null}
                            </td>
                          );
                        }
                        return (
                          <td key={cell.id} className="truncate">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                    {isExpanded && renderExpandedRow ? (
                      <tr>
                        <td colSpan={visibleColumnCount} className="!p-0 !bg-transparent">
                          <div className="mx-1 mb-1.5 rounded-lg border border-border/60 bg-background/90 px-4 py-3 shadow-sm">
                            {renderExpandedRow(row.original)}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {onLoadMore && hasMore && (
                <LoadMoreRow
                  colSpan={visibleColumnCount}
                  loading={!!loadingMore}
                  onLoadMore={onLoadMore}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {children}
    </>
  );
}

function ColumnVisibilityMenu<T>({ table }: { table: TanstackTable<T> }) {
  const hideableColumns = table.getAllColumns().filter((c) => c.getCanHide());
  if (hideableColumns.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="ml-auto shrink-0">
          <SettingsIcon className="size-3.5" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
          Visible columns
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(value) => column.toggleVisibility(!!value)}
            onSelect={(e) => e.preventDefault()}
            className="capitalize"
          >
            {column.getIsVisible() ? (
              <EyeIcon className="size-3.5 opacity-60" />
            ) : (
              <EyeOffIcon className="size-3.5 opacity-60" />
            )}
            {String(column.id)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows({ colSpan }: { colSpan: number }) {
  const cols = colSpan || 4;
  return (
    <div className="pb-4">
      <table className="w-full table-fixed border-separate border-spacing-y-1.5">
        <tbody>
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <tr
              key={`sk-${rowIdx}`}
              className={cn(
                "bg-muted/60",
                "[&>td]:bg-transparent [&>td]:px-3 [&>td]:py-2 [&>td]:align-middle",
                "[&>td:first-child]:rounded-l-lg",
                "[&>td:last-child]:rounded-r-lg",
              )}
            >
              {Array.from({ length: cols }).map((_, colIdx) => {
                const widthClass = (() => {
                  if (colIdx === 0) return rowIdx % 2 === 0 ? "w-[55%]" : "w-[42%]";
                  if (colIdx === cols - 1)
                    return rowIdx % 2 === 0 ? "w-[38%]" : "w-[48%]";
                  return rowIdx % 3 === 0 ? "w-[85%]" : rowIdx % 3 === 1 ? "w-[72%]" : "w-[60%]";
                })();
                return (
                  <td key={colIdx}>
                    <Skeleton className={`h-3.5 ${widthClass}`} rounded="sm" />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoadMoreRow({
  colSpan,
  loading,
  onLoadMore,
}: {
  colSpan: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) {
          onLoadMore();
        }
      },
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, onLoadMore]);

  return (
    <tr ref={ref}>
      <td colSpan={colSpan} className="text-center py-4 text-xs text-muted-foreground">
        {loading ? "Loading more…" : " "}
      </td>
    </tr>
  );
}

export { type ColumnDef } from "@tanstack/react-table";
