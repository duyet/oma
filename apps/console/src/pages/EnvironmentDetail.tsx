import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "@/components/ui/form-select";
import { toast } from "sonner";
import { Page } from "../components/Page";
import { Field } from "@/components/ui/field";
import { friendlyHostingDescription, type HostingTypeLike } from "../lib/hostingTypes";
import {
  PACKAGE_PRESETS,
  getProviderGuidance,
  type CfAvailability,
  type PackagePreset,
} from "../lib/environmentPresets";
import { ProviderMark } from "../components/ProviderMark";
import {
  EnvVarsEditor,
  envVarsToRows,
  rowsToEnvVars,
  type EnvVarRow,
  type EnvVarSpec,
} from "../components/EnvVarsEditor";

// =================================================================
// Types
// =================================================================

/** Package managers exposed in the UI dropdown.
 *  NOTE: `gem` exists in the schema but is intentionally omitted —
 *  OMA's sandbox-base doesn't have ruby installed yet. If the env
 *  already carries gem packages we round-trip them on save so we
 *  don't silently drop user data. */
const MANAGERS = ["apt", "cargo", "go", "npm", "pip"] as const;
type Manager = (typeof MANAGERS)[number];
const ALL_MANAGERS = [...MANAGERS, "gem"] as const;
type AnyManager = (typeof ALL_MANAGERS)[number];

interface NetworkingConfig {
  type: "unrestricted" | "limited";
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
}

interface ResourcesConfig {
  instance_type?: string;
  cpu?: string;
  memory?: string;
  disk?: string;
}

/** CF Containers instance type presets with resource specs. */
const CF_INSTANCE_TYPES: { id: string; label: string; cpu: string; memory: string; disk: string }[] = [
  { id: "lite", label: "Lite", cpu: "1/16 vCPU", memory: "256 MiB", disk: "2 GB" },
  { id: "basic", label: "Basic", cpu: "1/4 vCPU", memory: "1 GiB", disk: "4 GB" },
  { id: "standard-1", label: "Standard 1", cpu: "1/2 vCPU", memory: "4 GiB", disk: "8 GB" },
  { id: "standard-2", label: "Standard 2", cpu: "1 vCPU", memory: "6 GiB", disk: "12 GB" },
  { id: "standard-3", label: "Standard 3", cpu: "2 vCPU", memory: "8 GiB", disk: "16 GB" },
  { id: "standard-4", label: "Standard 4", cpu: "4 vCPU", memory: "12 GiB", disk: "20 GB" },
];

/** K8s instance type presets. */
const K8S_INSTANCE_TYPES: { id: string; label: string; cpu: string; memory: string; disk: string }[] = [
  { id: "small", label: "Small", cpu: "0.5 vCPU", memory: "512 MiB", disk: "2 GB" },
  { id: "medium", label: "Medium", cpu: "1 vCPU", memory: "1 GiB", disk: "4 GB" },
  { id: "large", label: "Large", cpu: "2 vCPU", memory: "4 GiB", disk: "8 GB" },
];

/** Map provider type to available instance types. */
function instanceTypesForProvider(provider: string): { id: string; label: string; cpu: string; memory: string; disk: string }[] {
  if (provider === "k8s" || provider === "kubernetes") return K8S_INSTANCE_TYPES;
  if (provider === "subprocess" || provider === "litebox" || provider === "boxrun" || provider === "daytona" || provider === "e2b") {
    return [{ id: "default", label: "Default", cpu: "Host", memory: "Host", disk: "Host" }];
  }
  return CF_INSTANCE_TYPES;
}

interface EnvConfigBlock {
  type: string;
  /** Preferred over `type` when set — see AGENTS.md "Environments" and
   *  packages/sandbox-sdk/src/provider-config.ts. Read-only here; the create
   *  dialog (EnvironmentsList) only ever sets `type`, so this is populated
   *  by API/CLI-created environments. */
  sandbox_provider?: string;
  packages?: Partial<Record<AnyManager, string[]>>;
  networking?: NetworkingConfig;
  dockerfile?: string;
  resources?: ResourcesConfig;
  env_vars?: EnvVarSpec[];
}

interface Env {
  id: string;
  name: string;
  description?: string;
  config: EnvConfigBlock;
  status?: "building" | "ready" | "error";
  build_error?: string;
  metadata?: Record<string, unknown>;
  image_strategy?: "base_snapshot" | "dockerfile";
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// Local editor row shapes — packages and metadata both use ordered
// row arrays so the UI keeps a stable visual position while editing,
// rather than reshuffling whenever the underlying object's key order
// changes during normalize-on-save.
export interface PackageRow {
  manager: Manager;
  /** Space-separated package specs, e.g. `pandas numpy==2.0` */
  packages: string;
}
interface MetadataRow {
  key: string;
  value: string;
}

// =================================================================
// Page
// =================================================================

export function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const nav = useNavigate();

  const [env, setEnv] = useState<Env | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hosting-type metadata (label + description) for the badge/subtitle
  // below the name. Mirrors EnvironmentsList's fetch — the CF host 404s
  // this route, so we silently fall back to just showing the raw type id.
  const [hostingTypes, setHostingTypes] = useState<HostingTypeLike[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ data: HostingTypeLike[] }>("/v1/hosting_types");
        if (!cancelled && Array.isArray(res.data)) setHostingTypes(res.data);
      } catch {
        // no-op — fall back to raw type id in the badge
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Editable form state (kept separate from `env` so Cancel can revert
  // without re-fetching, and so we can diff to detect "dirty" later if
  // we ever want to show an unsaved-changes guard).
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [networking, setNetworking] = useState<NetworkingConfig>({
    type: "unrestricted",
    allow_mcp_servers: false,
    allow_package_managers: false,
    allowed_hosts: [],
  });
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [packageRows, setPackageRows] = useState<PackageRow[]>([]);
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);
  const [envVarRows, setEnvVarRows] = useState<EnvVarRow[]>([]);
  // `gem` packages aren't editable (no UI row) — preserved verbatim
  // so save doesn't silently strip them.
  const [preservedGem, setPreservedGem] = useState<string[] | undefined>(undefined);

  // Sandbox resource selection
  const [resources, setResources] = useState<ResourcesConfig>({});

  // Initial load via TQ. Re-renders when the cache is populated; the
  // applyEnv side-effect below seeds the editable form state once per
  // fetched payload (id changes between renders → form re-seeds).
  const { data: fetchedEnv, error: fetchError } = useApiQuery<Env>(
    id ? `/v1/environments/${id}` : null,
  );
  useEffect(() => {
    if (fetchedEnv) applyEnv(fetchedEnv);
    // applyEnv only depends on `fetchedEnv` (it's a closure over the
    // setters which are stable from useState). Disabled the lint rule
    // because pulling applyEnv into deps would require memoizing every
    // setter chain — simpler to keep this an "on data arrival" effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedEnv]);
  useEffect(() => {
    if (fetchError) {
      setLoadError(fetchError instanceof Error ? fetchError.message : "load failed");
    }
  }, [fetchError]);

  function applyEnv(e: Env) {
    setEnv(e);
    setName(e.name);
    setDescription(e.description ?? "");

    const net: NetworkingConfig = e.config.networking ?? { type: "unrestricted" };
    setNetworking({
      type: net.type ?? "unrestricted",
      allow_mcp_servers: !!net.allow_mcp_servers,
      allow_package_managers: !!net.allow_package_managers,
      allowed_hosts: net.allowed_hosts ?? [],
    });
    setAllowedHostsText((net.allowed_hosts ?? []).join(", "));

    setPackageRows(packagesToRows(e.config.packages));
    setPreservedGem(e.config.packages?.gem);

    setResources(e.config.resources ?? {});

    setMetadataRows(metadataToRows(e.metadata));
    setEnvVarRows(envVarsToRows(e.config.env_vars));
  }

  async function save() {
    if (!id || !env) return;
    setSaving(true);
    try {
      const config: EnvConfigBlock = {
        // Preserve type ("cloud") and any dockerfile field — we don't expose
        // dockerfile in MVP UI, so it must round-trip untouched.
        type: env.config.type,
        ...(env.config.dockerfile !== undefined ? { dockerfile: env.config.dockerfile } : {}),
        packages: rowsToPackages(packageRows, preservedGem),
        networking: buildNetworking(networking, allowedHostsText),
        resources: buildResources(resources, env.config.type),
        env_vars: rowsToEnvVars(envVarRows),
      };

      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        config,
        metadata: rowsToMetadata(metadataRows),
      };

      const updated = await api<Env>(`/v1/environments/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      applyEnv(updated);
      toast.success("Environment saved");
    } catch (err) {
      // useApi already toasts the underlying error; no duplicate here.
      void err;
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    nav("/environments");
  }

  if (loadError) {
    return (
      <div className="flex-1 p-8">
        <div className="bg-danger-subtle border border-danger/30 rounded-lg p-4 text-danger text-sm">
          {loadError}
        </div>
      </div>
    );
  }
  if (!env) {
    return <div className="flex-1 p-8 text-muted-foreground">Loading...</div>;
  }

  const metadataHasError = metadataRows.some(
    (row) => row.key.length > 0 && !isValidMetadataKey(row.key),
  );

  const typeId = env.config.type || "cloud";
  // `sandbox_provider` takes precedence over the legacy `type` field when
  // both are present (mirrors RuntimeInfo.tsx / StackedAssembly.tsx).
  const providerId = env.config.sandbox_provider ?? typeId;
  const providerInfo = hostingTypes.find((t) => t.id === typeId);
  const providerLabel = providerInfo?.label ?? (typeId === "cloud" ? "Cloudflare Sandbox" : typeId);
  const providerDescription = providerInfo
    ? friendlyHostingDescription(providerInfo)
    : typeId === "cloud"
      ? friendlyHostingDescription({ id: "cloud", label: providerLabel })
      : undefined;

  return (
    <Page>
      <div className="max-w-6xl space-y-6">
        {/* Header: name input + hosting-type badge + status */}
        <section className="space-y-3">
          <h1 className="sr-only">{env.name || "Environment"}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="sr-only" htmlFor="env-name">Environment name</label>
            <input
              id="env-name"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 50))}
              className="border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-background text-foreground outline-none focus:border-primary transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] w-full sm:w-72"
              placeholder="environment name"
            />
            <span className="text-[11px] px-2 py-0.5 rounded-2xl border border-border bg-muted text-muted-foreground font-medium uppercase tracking-wider">
              {providerLabel}
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              <GlobeIcon />
            </span>
            {/* Status chip + build_error banner removed — env is stateless
                post setup-on-warmup migration; status is always "ready"
                (and the field is no longer surfaced on the wire). Package
                install errors surface on the first session that uses the
                env, not at env-creation time. */}
          </div>
          {providerDescription && (
            <p className="text-xs text-muted-foreground">{providerDescription}</p>
          )}

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5" htmlFor="env-description">
              Description
            </label>
            <textarea
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-background text-foreground outline-none focus:border-primary transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-muted-foreground resize-y"
              placeholder="What is this environment for?"
            />
          </div>
        </section>

        {/* Provider-aware guidance — required secrets, CF vs self-host
            availability, and networking notes for the provider already
            selected at creation time (badge above). Fail-soft for
            unrecognized/custom BYOK provider ids. */}
        <ProviderGuidancePanel providerId={providerId} />

        {/* Section cards — single column on small screens, two-column
            grid on xl so the page uses wide viewports instead of one
            long scroll. `items-start` keeps cards from stretching to
            match their row partner's height. */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">

        {/* Networking */}
        <SectionCard
          title="Networking"
          subtitle="Configure network access policies for this environment."
        >
          <div className="space-y-4">
            <Field label="Type">
              <div className="w-48">
                <Select
                  value={networking.type}
                  onValueChange={(v) =>
                    setNetworking({
                      ...networking,
                      type: v as NetworkingConfig["type"],
                    })
                  }
                >
                  <SelectOption value="unrestricted">Unrestricted</SelectOption>
                  <SelectOption value="limited">Limited</SelectOption>
                </Select>
              </div>
            </Field>

            <Toggle
              label="Allow MCP server network access"
              checked={!!networking.allow_mcp_servers}
              onChange={(v) =>
                setNetworking({ ...networking, allow_mcp_servers: v })
              }
            />
            <Toggle
              label="Allow package manager network access"
              checked={!!networking.allow_package_managers}
              onChange={(v) =>
                setNetworking({ ...networking, allow_package_managers: v })
              }
            />

            {networking.type === "limited" && (
              <Field
                label="Allowed Hosts"
                hint="Comma-separated hostnames (e.g. www.example1.com, api.example2.com)"
              >
                <textarea
                  value={allowedHostsText}
                  onChange={(e) => setAllowedHostsText(e.target.value)}
                  rows={2}
                  className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle resize-y"
                  placeholder="www.example1.com, www.example2.com"
                />
              </Field>
            )}
          </div>
        </SectionCard>

        {/* Sandbox Resources */}
        <SectionCard
          title="Sandbox Resources"
          subtitle="Select the instance size for this environment's sandbox containers. Provider-specific presets."
        >
          <div className="space-y-4">
            <Field label="Instance Type">
              <div className="w-full max-w-xs">
                <Select
                  value={resources.instance_type ?? "__provider_default__"}
                  onValueChange={(v) => {
                    if (v === "__provider_default__") {
                      setResources({ instance_type: undefined });
                      return;
                    }
                    const preset = instanceTypesForProvider(env.config.type).find((t) => t.id === v);
                    setResources({
                      instance_type: v,
                      cpu: preset?.cpu,
                      memory: preset?.memory,
                      disk: preset?.disk,
                    });
                  }}
                >
                  <SelectOption value="__provider_default__">Provider default</SelectOption>
                  {instanceTypesForProvider(env.config.type).map((t) => (
                    <SelectOption key={t.id} value={t.id}>
                      {t.label} — {t.cpu}, {t.memory}, {t.disk}
                    </SelectOption>
                  ))}
                </Select>
              </div>
            </Field>
            {resources.instance_type && (
              <div className="grid grid-cols-3 gap-3 text-xs text-fg-muted">
                <div className="border border-border rounded px-3 py-2 bg-bg-surface/30">
                  <span className="block font-medium text-fg">CPU</span>
                  {resources.cpu ?? "—"}
                </div>
                <div className="border border-border rounded px-3 py-2 bg-bg-surface/30">
                  <span className="block font-medium text-fg">Memory</span>
                  {resources.memory ?? "—"}
                </div>
                <div className="border border-border rounded px-3 py-2 bg-bg-surface/30">
                  <span className="block font-medium text-fg">Disk</span>
                  {resources.disk ?? "—"}
                </div>
              </div>
            )}
          </div>
        </SectionCard>

        {/* Packages */}
        <SectionCard
          title="Packages"
          subtitle="Specify packages and their versions available in this environment. Separate multiple values with spaces."
          action={
            <IconButton
              label="Add package row"
              onClick={() =>
                setPackageRows((rows) => [...rows, { manager: "pip", packages: "" }])
              }
            >
              <PlusIcon />
            </IconButton>
          }
        >
          <div className="flex flex-wrap gap-1.5 mb-3 pb-3 border-b border-border">
            {PACKAGE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() =>
                  setPackageRows((rows) => applyPackagePreset(rows, preset))
                }
                className="text-[11px] px-2.5 py-1 rounded-full border border-border bg-bg-surface text-fg-muted hover:text-fg hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] min-h-11 sm:min-h-0"
              >
                + {preset.label}
              </button>
            ))}
          </div>
          {packageRows.length === 0 ? (
            <p className="text-[13px] text-fg-subtle italic">
              No packages configured.
            </p>
          ) : (
            <div className="space-y-2">
              {packageRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-24 shrink-0">
                    <Select
                      value={row.manager}
                      onValueChange={(v) =>
                        setPackageRows((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, manager: v as Manager } : r,
                          ),
                        )
                      }
                    >
                      {MANAGERS.map((m) => (
                        <SelectOption key={m} value={m}>{m}</SelectOption>
                      ))}
                    </Select>
                  </div>
                  <input
                    value={row.packages}
                    onChange={(e) =>
                      setPackageRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, packages: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="package package==1.0.0"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono"
                  />
                  <IconButton
                    label="Remove package row"
                    onClick={() =>
                      setPackageRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {preservedGem && preservedGem.length > 0 && (
            <p className="text-[12px] text-fg-subtle mt-3 pt-3 border-t border-border">
              {preservedGem.length} legacy gem package(s) preserved (not editable
              — Ruby is not in sandbox-base yet).
            </p>
          )}
        </SectionCard>

        {/* Metadata */}
        <SectionCard
          title="Metadata"
          subtitle="Add custom key-value pairs to tag and organize this environment. Keys must be lowercase."
          action={
            <IconButton
              label="Add metadata row"
              onClick={() =>
                setMetadataRows((rows) => [...rows, { key: "", value: "" }])
              }
            >
              <PlusIcon />
            </IconButton>
          }
        >
          {metadataRows.length === 0 ? (
            <p className="text-[13px] text-fg-subtle italic">No metadata.</p>
          ) : (
            <div className="space-y-2">
              {metadataRows.map((row, i) => {
                const keyInvalid = row.key.length > 0 && !isValidMetadataKey(row.key);
                return (
                  <div key={i}>
                    <div className="flex items-center gap-2">
                      <input
                        value={row.key}
                        onChange={(e) =>
                          setMetadataRows((rows) =>
                            rows.map((r, j) =>
                              j === i ? { ...r, key: e.target.value } : r,
                            ),
                          )
                        }
                        placeholder="client_key"
                        aria-label="Metadata key"
                        aria-invalid={keyInvalid}
                        className={`flex-1 min-w-0 border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono ${
                          keyInvalid ? "border-danger" : "border-border"
                        }`}
                      />
                      <input
                        value={row.value}
                        onChange={(e) =>
                          setMetadataRows((rows) =>
                            rows.map((r, j) =>
                              j === i ? { ...r, value: e.target.value } : r,
                            ),
                          )
                        }
                        placeholder="Value"
                        aria-label="Metadata value"
                        className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
                      />
                      <IconButton
                        label="Remove metadata row"
                        onClick={() =>
                          setMetadataRows((rows) => rows.filter((_, j) => j !== i))
                        }
                      >
                        <TrashIcon />
                      </IconButton>
                    </div>
                    {keyInvalid && (
                      <p className="mt-1 text-[12px] text-danger">
                        Keys must be lowercase.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* Environment variables — full width, the table needs room */}
        <SectionCard
          title="Environment variables"
          subtitle="Persistent variables injected into every session's sandbox created from this environment. Mark a variable sensitive to store it as a secret (masked, never returned by the API)."
          className="xl:col-span-2"
        >
          <EnvVarsEditor rows={envVarRows} setRows={setEnvVarRows} />
        </SectionCard>

        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            onClick={save}
            loading={saving}
            disabled={!name.trim() || metadataHasError}
          >
            Save changes
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <span className="text-xs text-fg-subtle ml-auto font-mono">
            {env.id}
          </span>
        </div>
      </div>
    </Page>
  );
}

// =================================================================
// Section / form primitives
// =================================================================

function SectionCard({
  title,
  subtitle,
  action,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`border border-border rounded-lg bg-bg-surface/30 ${className ?? ""}`}>
      <header className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-fg">{title}</h2>
          {subtitle && (
            <p className="text-[12px] text-fg-muted mt-0.5">{subtitle}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

const CF_STATUS_STYLE: Record<CfAvailability, { dot: string; label: string }> = {
  default: { dot: "bg-success", label: "Default" },
  available: { dot: "bg-success", label: "Available" },
  relay: { dot: "bg-brand", label: "Bridge relay" },
  unavailable: { dot: "bg-danger", label: "Unavailable" },
};

/** Concise, provider-specific callout: required secrets, Cloudflare vs
 *  self-host availability, and networking notes — derived from the
 *  AGENTS.md sandbox-provider table (see lib/environmentPresets.ts).
 *  Fails soft (generic message, no error) for a provider id it doesn't
 *  recognize, e.g. a custom BYOK provider. */
function ProviderGuidancePanel({ providerId }: { providerId: string }) {
  const guidance = getProviderGuidance(providerId);

  return (
    <SectionCard
      title="Sandbox provider guidance"
      subtitle="Required secrets, Cloudflare vs. self-host availability, and networking notes for this environment's provider."
    >
      <div className="flex items-start gap-3">
        <ProviderMark id={providerId} colored className="size-5 shrink-0 mt-0.5 text-fg-subtle" />
        <div className="flex-1 min-w-0 space-y-3">
          {!guidance ? (
            <p className="text-[13px] text-fg-muted">
              No specific guidance for{" "}
              <code className="font-mono text-xs bg-bg-surface px-1 rounded">{providerId}</code>.
              This looks like a custom or newly registered provider — check its live health on
              the{" "}
              <Link to="/runtimes" className="underline hover:text-fg">
                Runtimes
              </Link>{" "}
              page.
            </p>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <GuidanceRow
                  title="Cloudflare deployment"
                  status={guidance.cf.status}
                  note={guidance.cf.note}
                />
                <GuidanceRow title="Self-host Node" status="available" note={guidance.selfHost.note} />
              </div>
              {(guidance.requiredSecret || guidance.optionalSecret) && (
                <div className="text-[12px] text-fg-muted space-y-0.5">
                  {guidance.requiredSecret && (
                    <div>
                      <span className="text-fg-subtle">Required secret:</span>{" "}
                      <code className="font-mono text-xs bg-bg-surface px-1 rounded text-fg">
                        {guidance.requiredSecret}
                      </code>
                    </div>
                  )}
                  {guidance.optionalSecret && (
                    <div>
                      <span className="text-fg-subtle">Optional:</span>{" "}
                      <code className="font-mono text-xs bg-bg-surface px-1 rounded text-fg">
                        {guidance.optionalSecret}
                      </code>
                    </div>
                  )}
                </div>
              )}
              {guidance.networking && (
                <p className="text-[12px] text-fg-muted">
                  <span className="text-fg-subtle">Networking:</span> {guidance.networking}
                </p>
              )}
              {guidance.limitations && guidance.limitations.length > 0 && (
                <ul className="text-[12px] text-fg-subtle list-disc ml-4 space-y-0.5">
                  {guidance.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function GuidanceRow({
  title,
  status,
  note,
}: {
  title: string;
  status: CfAvailability;
  note: string;
}) {
  const style = CF_STATUS_STYLE[status];
  return (
    <div className="rounded-md border border-border bg-bg-surface/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} aria-hidden="true" />
        {title}
        <span className="text-fg-subtle font-normal">· {style.label}</span>
      </div>
      <p className="text-[12px] text-fg-muted mt-1 leading-relaxed">{note}</p>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 min-h-11 sm:min-h-0 cursor-pointer">
      <span className="text-[13px] text-fg">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none ${
          checked ? "bg-brand" : "bg-bg-surface border border-border"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

function IconButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
    >
      {children}
    </button>
  );
}

// =================================================================
// Icons
// =================================================================

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8h-7A2 2 0 0 1 6.5 20L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
    </svg>
  );
}

// =================================================================
// Pure helpers — kept module-level so they can be unit-tested without
// pulling React in. They handle the schema <-> editor-row mapping for
// packages and metadata.
// =================================================================

export function packagesToRows(
  packages: Partial<Record<AnyManager, string[]>> | undefined,
): PackageRow[] {
  if (!packages) return [];
  const rows: PackageRow[] = [];
  for (const m of MANAGERS) {
    const list = packages[m];
    if (list && list.length > 0) {
      rows.push({ manager: m, packages: list.join(" ") });
    }
  }
  return rows;
}

export function rowsToPackages(
  rows: PackageRow[],
  preservedGem?: string[],
): Partial<Record<AnyManager, string[]>> {
  const out: Partial<Record<AnyManager, string[]>> = {};
  for (const row of rows) {
    const specs = row.packages
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) continue;
    // Multiple rows with the same manager merge — user-friendly default
    // since the UI doesn't enforce uniqueness.
    const existing = out[row.manager] ?? [];
    out[row.manager] = [...existing, ...specs];
  }
  if (preservedGem && preservedGem.length > 0) {
    out.gem = preservedGem;
  }
  return out;
}

/** Merge a package preset into the current editor rows. For each manager
 *  the preset touches: appends to that manager's existing row (deduping
 *  exact spec matches) if one exists, otherwise adds a new row. Presets
 *  never remove or overwrite user-entered packages. */
export function applyPackagePreset(
  rows: PackageRow[],
  preset: PackagePreset,
): PackageRow[] {
  const next = [...rows];
  for (const manager of MANAGERS) {
    const specs = preset.packages[manager];
    if (!specs || specs.length === 0) continue;
    const idx = next.findIndex((r) => r.manager === manager);
    if (idx === -1) {
      next.push({ manager, packages: specs.join(" ") });
      continue;
    }
    const existing = next[idx].packages
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [...existing];
    for (const spec of specs) {
      if (!merged.includes(spec)) merged.push(spec);
    }
    next[idx] = { ...next[idx], packages: merged.join(" ") };
  }
  return next;
}

export function metadataToRows(
  metadata: Record<string, unknown> | undefined,
): MetadataRow[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

export function rowsToMetadata(rows: MetadataRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value;
  }
  return out;
}

/** Metadata keys must be lowercase — mirrors the copy in the Metadata
 *  section subtitle. An empty key is treated as valid here (it's simply
 *  dropped by `rowsToMetadata`, not flagged as an error to the user). */
export function isValidMetadataKey(key: string): boolean {
  return key === key.toLowerCase();
}

function buildResources(res: ResourcesConfig, provider: string): ResourcesConfig {
  const cleaned: ResourcesConfig = {};
  if (res.instance_type) {
    cleaned.instance_type = res.instance_type;
    // Populate cpu/memory/disk from preset when the user picks one
    const all = instanceTypesForProvider(provider);
    const preset = all.find((t) => t.id === res.instance_type);
    if (preset) {
      cleaned.cpu = preset.cpu;
      cleaned.memory = preset.memory;
      cleaned.disk = preset.disk;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined as unknown as ResourcesConfig;
}

function buildNetworking(
  net: NetworkingConfig,
  allowedHostsText: string,
): NetworkingConfig {
  const hosts = allowedHostsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (net.type === "unrestricted") {
    return {
      type: "unrestricted",
      allow_mcp_servers: !!net.allow_mcp_servers,
      allow_package_managers: !!net.allow_package_managers,
      // Drop allowed_hosts when unrestricted — it's meaningless and the
      // backend may complain about stale entries.
    };
  }
  return {
    type: "limited",
    allow_mcp_servers: !!net.allow_mcp_servers,
    allow_package_managers: !!net.allow_package_managers,
    allowed_hosts: hosts,
  };
}
