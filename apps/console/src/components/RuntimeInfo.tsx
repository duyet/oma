import { useApiQuery } from "../lib/useApiQuery";
import { friendlyHostingDescription } from "../lib/hostingTypes";
import { ProviderMark } from "./ProviderMark";
import { harnessDescription, harnessLabel, harnessOption } from "../pages/agents/harness-options";

/** Default container image per sandbox provider when the environment
 *  doesn't set config.image / SANDBOX_IMAGE explicitly — see
 *  docs/runtimes.md's provider table. */
const DEFAULT_IMAGES: Record<string, string> = {
  cloud: "ghcr.io/duyet/sandbox-base:latest",
  openshell: "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
  daytona: "ghcr.io/duyet/oma-runtime-base:latest",
  k8s: "ghcr.io/duyet/oma-runtime-base:latest",
  "k8s-bridge": "ghcr.io/duyet/oma-runtime-base:latest",
  "k8s-remote": "ghcr.io/duyet/oma-runtime-base:latest",
  boxrun: "set via SANDBOX_IMAGE (no fixed default)",
  e2b: "E2B template (node:22-slim-equivalent default)",
  subprocess: "N/A — runs on the host",
  litebox: "N/A — fixed rootfs",
};

interface EnvRecord {
  id: string;
  name: string;
  config: {
    type?: string;
    sandbox_provider?: string;
    image?: string;
    packages?: Partial<Record<string, string[]>>;
  };
}

function envImage(config: EnvRecord["config"]): string {
  if (config.image) return config.image;
  const providerId = config.sandbox_provider ?? config.type ?? "cloud";
  return DEFAULT_IMAGES[providerId] ?? "unknown";
}

function packagesSummary(packages: EnvRecord["config"]["packages"]): string {
  if (!packages) return "None";
  const parts = Object.entries(packages)
    .filter(([, list]) => list && list.length > 0)
    .map(([manager, list]) => `${manager}: ${list!.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "None";
}

/**
 * Read-only "where does this agent run" section for the agent editor
 * (AgentBuilder / AgentEditDialog). Agents don't pin an environment —
 * sessions do — so this shows the harness (the loop implementation) plus
 * every environment the tenant's sessions could run in, with its sandbox
 * provider, container image, and package summary.
 */
export function RuntimeInfo({ harness }: { harness: string }) {
  const { data, isLoading } = useApiQuery<{ data: EnvRecord[] }>("/v1/environments");
  const environments = data?.data ?? [];
  const harnessKey = harness || "default";
  const option = harnessOption(harnessKey);

  return (
    <div className="space-y-4">
      <div>
        <span className="text-xs text-fg-muted block mb-1">Harness</span>
        <p className="text-sm text-fg font-medium flex items-center gap-2 flex-wrap">
          <span>{harnessLabel(harnessKey)}</span>
          {option && (
            <span className="text-[10px] rounded px-1 py-0.5 bg-bg-surface text-fg-subtle font-normal">
              {option.badge}
            </span>
          )}
          <span className="text-[10px] font-mono text-fg-subtle font-normal">{harnessKey}</span>
        </p>
        <p className="text-xs text-fg-subtle mt-0.5">{harnessDescription(harnessKey)}</p>
        {option?.note && (
          <p className="text-xs text-fg-subtle mt-1 bg-bg-surface rounded-md px-2 py-1.5">{option.note}</p>
        )}
      </div>

      <div>
        <span className="text-xs text-fg-muted block mb-1">
          Environments <span className="text-fg-subtle">(sessions choose one at creation)</span>
        </span>
        {isLoading ? (
          <p className="text-xs text-fg-subtle">Loading…</p>
        ) : environments.length === 0 ? (
          <p className="text-xs text-fg-subtle">
            No environments yet —{" "}
            <a href="/environments" className="text-brand hover:underline">
              create one
            </a>{" "}
            so this agent&apos;s sessions have somewhere to run.
          </p>
        ) : (
          <div className="space-y-2">
            {environments.map((env) => {
              const providerId = env.config.sandbox_provider ?? env.config.type ?? "cloud";
              return (
                <div
                  key={env.id}
                  className="flex items-start gap-3 border border-border rounded-md px-3 py-2"
                >
                  <ProviderMark id={providerId} colored className="size-4 mt-0.5 shrink-0 text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-fg truncate">{env.name}</span>
                      <span className="text-xs text-fg-subtle font-mono">{providerId}</span>
                    </div>
                    <p className="text-xs text-fg-subtle mt-0.5">
                      {friendlyHostingDescription({ id: providerId, label: providerId })}
                    </p>
                    <p className="text-xs text-fg-muted mt-1 font-mono truncate">
                      {envImage(env.config)}
                    </p>
                    <p className="text-xs text-fg-subtle mt-0.5">
                      Packages: {packagesSummary(env.config.packages)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
