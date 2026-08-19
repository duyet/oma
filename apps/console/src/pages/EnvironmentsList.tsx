import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, TrashIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { useConfirm } from "@/hooks/useConfirm";
import { Select, SelectOption } from "@/components/ui/form-select";
import { EnvVarsEditor, rowsToEnvVars, type EnvVarRow } from "../components/EnvVarsEditor";
import { DataTable, ExpandedDetail, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { friendlyHostingDescription } from "../lib/hostingTypes";
import {
  filterReadyProviders,
  type ProviderAvailability,
} from "../lib/providerAvailability";

interface Env {
  id: string;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
  archived_at?: string;
  status?: string;
}

interface ResourcesConfig {
  instance_type?: string;
  cpu?: string;
  memory?: string;
  disk?: string;
}

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

interface HostingType {
  id: string;
  label: string;
  description?: string;
  /** From /v1/hosting_types — gates the create-dialog picker. */
  availability?: ProviderAvailability | null;
}

// Fallback when the host doesn't expose /v1/hosting_types (e.g. older CF
// builds without the route). Single Cloudflare Sandbox option; id stays
// "cloud" on the wire (backend stores config.type === "cloud").
const CLOUDFLARE_SANDBOX_ONLY: HostingType[] = [
  { id: "cloud", label: "Cloudflare Sandbox", description: "Managed sandbox, built in." },
];

const CF_INSTANCE_TYPES = [
  { id: "lite", label: "Lite", cpu: "1/16 vCPU", memory: "256 MiB", disk: "2 GB" },
  { id: "basic", label: "Basic", cpu: "1/4 vCPU", memory: "1 GiB", disk: "4 GB" },
  { id: "standard-1", label: "Standard 1", cpu: "1/2 vCPU", memory: "4 GiB", disk: "8 GB" },
  { id: "standard-2", label: "Standard 2", cpu: "1 vCPU", memory: "6 GiB", disk: "12 GB" },
  { id: "standard-3", label: "Standard 3", cpu: "2 vCPU", memory: "8 GiB", disk: "16 GB" },
  { id: "standard-4", label: "Standard 4", cpu: "4 vCPU", memory: "12 GiB", disk: "20 GB" },
];

const K8S_INSTANCE_TYPES = [
  { id: "small", label: "Small", cpu: "0.5 vCPU", memory: "512 MiB", disk: "2 GB" },
  { id: "medium", label: "Medium", cpu: "1 vCPU", memory: "1 GiB", disk: "4 GB" },
  { id: "large", label: "Large", cpu: "2 vCPU", memory: "4 GiB", disk: "8 GB" },
];

function instanceTypesForProvider(provider: string) {
  if (provider === "k8s" || provider === "kubernetes") return K8S_INSTANCE_TYPES;
  if (provider === "cloud" || provider === "cloudflare") return CF_INSTANCE_TYPES;
  // Local / fixed-size providers (subprocess, litebox, docker-compose,
  // openshell, boxrun, …) have no instance sizing — the field is hidden.
  return [];
}

// Map a stored config.type (wire id, e.g. "cloud") to a human label. The
// CF host only knows "cloud"; self-host may advertise richer labels via
// /v1/hosting_types, which we prefer when available.
function hostingTypeLabel(type: string | undefined, known: HostingType[]): string {
  const id = type || "cloud";
  return known.find((t) => t.id === id)?.label ?? (id === "cloud" ? "Cloudflare Sandbox" : id);
}

export function EnvironmentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", type: "cloud", instanceType: "" });
  const [envVarRows, setEnvVarRows] = useState<EnvVarRow[]>([]);
  const confirm = useConfirm();

  // Hosting types from /v1/hosting_types include every provider this build
  // ships (plus unseeded diagnostics). The create dialog only offers
  // providers that are ready now (`availability.state === "available"`) —
  // needs_config / unavailable stay on Settings › Sandbox Runtimes.
  // 404 / empty → Cloudflare Sandbox only.
  const [hostingTypes, setHostingTypes] = useState<HostingType[]>(CLOUDFLARE_SANDBOX_ONLY);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ data: HostingType[] }>("/v1/hosting_types");
        if (!cancelled && Array.isArray(res.data) && res.data.length > 0) {
          // Drop empty ids — Radix Select crashes on value="".
          const cleaned = res.data.filter((t) => !!t.id && t.id.trim().length > 0);
          const ready = filterReadyProviders(cleaned, (t) => t.availability);
          // Never leave the picker empty; fall back to the CF default.
          setHostingTypes(ready.length > 0 ? ready : CLOUDFLARE_SANDBOX_ONLY);
        }
      } catch {
        // 404 / failure → keep Cloudflare Sandbox only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Keep form.type aligned with the filtered list once it loads (default
  // "cloud" may not be in the ready set on some deployments).
  useEffect(() => {
    if (hostingTypes.length === 0) return;
    if (!hostingTypes.some((t) => t.id === form.type)) {
      setForm((f) => ({ ...f, type: hostingTypes[0].id, instanceType: "" }));
    }
  }, [hostingTypes, form.type]);

  const selectedType = hostingTypes.find((t) => t.id === form.type) ?? hostingTypes[0];

  // Server-driven filter state. Each piece flows into envsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const envsParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [status, created.after, created.before, search],
  );

  const {
    items: envs,
    isLoading: loading,
    error,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Env>("/v1/environments", { limit: 20, params: envsParams });

  const create = async () => {
    const config: Record<string, unknown> = { type: form.type };
    if (form.instanceType) {
      const preset = instanceTypesForProvider(form.type).find((t) => t.id === form.instanceType);
      config.resources = {
        instance_type: form.instanceType,
        cpu: preset?.cpu,
        memory: preset?.memory,
        disk: preset?.disk,
      };
    }
    const envVars = rowsToEnvVars(envVarRows);
    if (envVars.length > 0) config.env_vars = envVars;
    await api("/v1/environments", {
      method: "POST",
      body: JSON.stringify({ name: form.name, config, description: form.description || undefined }),
    });
    setShowCreate(false); setForm({ name: "", description: "", type: "cloud", instanceType: "" }); setEnvVarRows([]); load();
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu.
  const columns = useMemo<ColumnDef<Env>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-fg-muted">
            {row.original.id}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "type",
        accessorFn: (e) => (e.config?.type as string) || "cloud",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {hostingTypeLabel(row.original.config?.type as string | undefined, hostingTypes)}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (e) => (e.archived_at ? "archived" : "active"),
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
              row.original.archived_at
                ? "bg-bg-surface text-fg-subtle"
                : "bg-success-subtle text-success"
            }`}
          >
            {row.original.archived_at ? "archived" : "active"}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (e) => e.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const e = row.original;
          const archived = !!e.archived_at;
          return (
            <RowActionsMenu
              label={`Actions for ${e.name}`}
              actions={[
                {
                  label: "Archive",
                  icon: <ArchiveIcon className="size-4" />,
                  disabled: archived,
                  onSelect: async () => {
                    try {
                      await api(`/v1/environments/${e.id}/archive`, {
                        method: "POST",
                        body: "{}",
                      });
                      load();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (
                      !(await confirm({
                        title: `Delete environment ${e.name}?`,
                        description: "This can't be undone.",
                        confirmLabel: "Delete",
                        destructive: true,
                      }))
                    )
                      return;
                    try {
                      await api(`/v1/environments/${e.id}`, { method: "DELETE" });
                      load();
                    } catch {}
                  },
                },
              ]}
            />
          );
        },
        enableHiding: false,
        enableResizing: false,
        size: 56,
      },
    ],
    [api, load, confirm],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾".
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <>
      <FilterChip
        label="Status"
        active={status !== "any"}
        display={statusDisplay}
        onClear={() => setStatus("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-48 p-0"
        >
          <FacetedFilter
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
            searchPlaceholder="Status..."
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  return (
    <DataTable<Env>
      subtitle="An environment defines the execution sandbox — packages, networking, container image — and is reusable across sessions."
      createLabel="+ Add environment"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search environments..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={envs}
      loading={loading}
      error={error}
      onRetry={load}
      errorTitle="Couldn't load environments"
      getRowId={(e) => e.id}
      onRowClick={(e) => nav(`/environments/${e.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? "No matching environments" : "No environments yet"}
      emptyKind="env"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}>+ Add environment</Button>
      }
      emptySubtitle={
        search
          ? "Try a different search term."
          : "An environment defines the sandbox your agents run in — packages, network access, and hardware. Create your first one to get started."
      }
      columns={columns}
      renderExpandedRow={(e) => (
        <ExpandedDetail
          rows={[
            { label: "ID", value: <span className="font-mono text-xs">{e.id}</span> },
            {
              label: "Provider",
              value: hostingTypeLabel(
                (e.config?.type ?? e.config?.sandbox_provider) as string | undefined,
                hostingTypes,
              ),
            },
            { label: "Status", value: e.status ?? "ready" },
            {
              label: "Created",
              value: new Date(e.created_at).toLocaleString(),
            },
          ]}
        />
      )}
    >
      <FormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Environment"
        subtitle="Environments provide isolated sandboxes for code execution."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="env-create-name" className="text-sm text-fg-muted block mb-1">Name</label>
            <input
              id="env-create-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 50) })}
              className="w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm outline-none focus:border-brand bg-bg text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
              placeholder="production"
            />
            <p className="text-xs text-fg-subtle mt-1">{form.name.length}/50 characters</p>
          </div>
          <div>
            <span className="text-sm text-fg-muted block mb-1">Hosting Type</span>
            <Select
              value={form.type}
              onValueChange={(v) => setForm({ ...form, type: v, instanceType: "" })}
            >
              {hostingTypes.map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.label}
                </SelectOption>
              ))}
            </Select>
            {selectedType && friendlyHostingDescription(selectedType) && (
              <p className="text-xs text-fg-subtle mt-1">
                {friendlyHostingDescription(selectedType)}
              </p>
            )}
            <p className="text-xs text-fg-subtle mt-1">This cannot be changed after creation.</p>
          </div>
          {instanceTypesForProvider(form.type).length > 0 && (
          <div>
            <span className="text-sm text-fg-muted block mb-1">Instance Type <span className="text-fg-subtle">(optional)</span></span>
            <Select
              value={form.instanceType || "__provider_default__"}
              onValueChange={(v) =>
                setForm({ ...form, instanceType: v === "__provider_default__" ? "" : v })
              }
            >
              <SelectOption value="__provider_default__">Provider default</SelectOption>
              {instanceTypesForProvider(form.type).map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.label} — {t.cpu}, {t.memory}, {t.disk}
                </SelectOption>
              ))}
            </Select>
            <p className="text-xs text-fg-subtle mt-1">Sandbox size. Only takes effect when the provider supports multiple sizes.</p>
          </div>
          )}
          <div>
            <label htmlFor="env-create-description" className="text-sm text-fg-muted block mb-1">Description <span className="text-fg-subtle">(optional)</span></label>
            <textarea
              id="env-create-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-brand bg-bg text-fg resize-none transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
              placeholder="Production environment for customer-facing agents..."
            />
          </div>
          <div>
            <span className="text-sm text-fg-muted block mb-1">Environment variables <span className="text-fg-subtle">(optional)</span></span>
            <EnvVarsEditor rows={envVarRows} setRows={setEnvVarRows} />
          </div>
        </div>
      </FormDialog>
    </DataTable>
  );
}
