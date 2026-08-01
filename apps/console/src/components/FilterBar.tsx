import type { ReactNode } from "react";

import { PopoverContent } from "@/components/ui/popover";
import { FacetedFilter, type FacetedFilterOption } from "./FacetedFilter";
import { FilterChip, CreatedFilterChip } from "./FilterChip";

/**
 * FilterBar — thin composition wrapper standardizing the filter-chip row
 * every list page renders into the DataTable toolbar's `filters` slot.
 *
 * It doesn't own new chrome; it just packages the currently-duplicated
 * "faceted-filter inside a chip inside a popover" boilerplate (see the
 * identical blocks in SessionsList / AgentsList) behind typed props for the
 * common trio — status, agent, created — while still accepting arbitrary
 * `children` so a page can slot extra facets.
 *
 * Render order is: `children`, then agent, status, created (each only when
 * its prop is supplied). Existing pages pass the common props and no
 * children, reproducing their exact chip order:
 *   - SessionsList → Agent, Status, Created
 *   - AgentsList   → Status, Created
 *
 * A future per-agent sessions tab can pass Version / Deployment `<FilterChip>`
 * children (they lead the row) alongside the common props.
 */

export interface FacetProp {
  value: string;
  onChange: (value: string) => void;
  options: FacetedFilterOption[];
  /** Chip label. */
  label?: string;
  /** Value that means "not filtering" — drives active/clear. Default "any". */
  defaultValue?: string;
  /** Search box placeholder inside the popover. */
  searchPlaceholder?: string;
}

export interface FilterBarProps {
  /** Extra leading chips (e.g. Version / Deployment facets). */
  children?: ReactNode;
  status?: FacetProp;
  agent?: FacetProp;
  created?: {
    value: { after?: number; before?: number };
    onChange: (v: { after?: number; before?: number }) => void;
    label?: string;
  };
}

/**
 * One faceted-filter chip: FilterChip trigger + a Popover hosting the
 * single-select FacetedFilter. Extracted from the copy-pasted blocks the
 * list pages carried inline.
 */
export function FacetChip({
  facet,
  defaultLabel,
  popoverWidth = "w-56",
}: {
  facet: FacetProp;
  defaultLabel: string;
  popoverWidth?: string;
}) {
  const label = facet.label ?? defaultLabel;
  const inactive = facet.defaultValue ?? "any";
  const active = facet.value !== inactive;
  const display = active
    ? facet.options.find((o) => o.value === facet.value)?.label ?? facet.value
    : undefined;

  return (
    <FilterChip
      label={label}
      active={active}
      display={display}
      onClear={() => facet.onChange(inactive)}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className={`${popoverWidth} p-0`}
      >
        <FacetedFilter
          options={facet.options}
          value={facet.value}
          onValueChange={facet.onChange}
          searchPlaceholder={facet.searchPlaceholder ?? `${label}...`}
        />
      </PopoverContent>
    </FilterChip>
  );
}

export function FilterBar({ children, status, agent, created }: FilterBarProps) {
  return (
    <>
      {children}
      {agent && (
        <FacetChip facet={agent} defaultLabel="Agent" popoverWidth="w-72" />
      )}
      {status && (
        <FacetChip facet={status} defaultLabel="Status" popoverWidth="w-48" />
      )}
      {created && (
        <CreatedFilterChip
          label={created.label}
          value={created.value}
          onChange={created.onChange}
        />
      )}
    </>
  );
}
