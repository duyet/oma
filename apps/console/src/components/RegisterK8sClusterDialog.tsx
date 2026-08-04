// Register-a-Kubernetes-cluster flow. Mints a pairing token against
// `POST /v1/runtimes/pairing-token`, then renders four copy-paste steps
// (token, values.yaml, kubectl secret, helm install) templated from the
// chosen backend / namespace / openshell options.
//
// Two exports:
//   - <RegisterK8sClusterForm /> — the inner content, embedded as the third
//     tab of <AddRuntimeDialog /> (same pattern as SandboxProviderFormFields
//     and ConnectMachineInstructions).
//   - <RegisterK8sClusterDialog /> — a standalone Modal wrapper, opened from
//     a K8s provider card's "Set up" action.
//
// The chart referenced is `oma-bridge-daemon` (the in-cluster bridge daemon
// that pairs a machine/cluster back to this OMA instance). NOT `oma-k8s-bridge`
// — that's the older CF→k8s HTTP bridge, a different thing entirely.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectOption } from "./Select";
import { TextInput } from "./Input";
import { CopyBlock } from "./CopyBlock";
import { useApi } from "../lib/api";

interface PairingToken {
  code: string;
  state: string;
  expires_at: number;
  kind: "k8s_pairing";
}

type Backend = "local" | "openshell";

const DOCS_URL = "https://docs.oma.duyet.net/deploy/k8s-sandbox-backends";
const CHART_README_URL =
  "https://github.com/duyet/oma/blob/main/charts/oma-bridge-daemon/README.md";

// Relative-time countdown for a future unix-second timestamp. Returns a
// coarse "~Nh Nm" / "~Nm" / "expired" string — good enough for a 24h token
// without dragging in a date-fns dependency.
function formatExpiry(expiresAtSeconds: number): string {
  const ms = expiresAtSeconds * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 1) return `expires in ~${hours}h ${mins}m`;
  if (mins >= 1) return `expires in ~${mins}m`;
  return "expires in <1m";
}

export function RegisterK8sClusterForm({
  copied,
  onCopy,
  onDone,
}: {
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onDone?: () => void;
}) {
  const { api } = useApi();
  const [backend, setBackend] = useState<Backend>("local");
  const [namespace, setNamespace] = useState("oma");
  const [openshellEnabled, setOpenshellEnabled] = useState(false);
  const [token, setToken] = useState<PairingToken | null>(null);
  const [loading, setLoading] = useState(false);
  // `now` exists only to re-render the countdown once a minute while a token
  // is live. It's read inside formatExpiry via Date.now() but we need state
  // to trigger the re-render.
  const [, setNow] = useState(0);

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [token]);

  // The daemon pairs back to whichever origin the Console is served from —
  // same host, same auth realm. `window.location.origin` is correct in the
  // browser; the SSR guard is defensive (Vite SPA renders client-side only).
  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  async function generateToken() {
    setLoading(true);
    try {
      const res = await api<PairingToken>("/v1/runtimes/pairing-token", {
        method: "POST",
        body: JSON.stringify({ ttl_hours: 24 }),
      });
      setToken(res);
    } catch {
      // api() already toasts network/auth failures.
    } finally {
      setLoading(false);
    }
  }

  async function revokeToken() {
    if (!token) return;
    try {
      await api(`/v1/runtimes/pairing-token/${token.code}`, {
        method: "DELETE",
      });
      setToken(null);
      toast.success("Pairing token revoked");
    } catch {
      // api() already toasts.
    }
  }

  // Templated install blocks. All four are pure functions of the form state
  // + the minted token, so changing the namespace or backend after minting
  // updates the commands in place — the token itself is independent.
  const valuesYaml = `pairing:
  existingSecret: oma-bridge-daemon-pairing
  serverUrl: ${serverUrl}
bridge:
  backend: ${backend}
  namespace: ${namespace}
openshell:
  enabled: ${openshellEnabled ? "true" : "false"}`;

  const kubectlCmd = token
    ? `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -\n` +
      `kubectl create secret generic oma-bridge-daemon-pairing \\\n` +
      `  --namespace ${namespace} \\\n` +
      `  --from-literal=OMA_PAIRING_CODE='${token.code}' \\\n` +
      `  --from-literal=OMA_PAIRING_STATE='${token.state}'`
    : "";

  const helmCmd = `helm install oma-bridge-daemon ./charts/oma-bridge-daemon \\\n` +
    `  --namespace ${namespace} \\\n` +
    `  -f values.yaml`;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        Deploy the{" "}
        <span className="text-fg">oma-bridge-daemon</span> Helm chart into your
        cluster. It pairs back to this OMA instance over a short-lived token
        and registers as a machine the{" "}
        <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">subprocess</code>{" "}
        sandbox provider can route work to.
      </p>

      {/* Options */}
      <div className="space-y-3">
        <div>
          <label className="block text-[13px] font-medium text-fg mb-1.5">
            Bridge backend
          </label>
          <Select
            value={backend}
            onValueChange={(v) => setBackend(v as Backend)}
          >
            <SelectOption value="local">
              local — relay sandboxes to a host on the cluster node (default)
            </SelectOption>
            <SelectOption value="openshell">
              openshell — delegate to an NVIDIA OpenShell gateway
            </SelectOption>
          </Select>
        </div>

        <TextInput
          label="Namespace"
          placeholder="oma"
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          hint="Kubernetes namespace the daemon installs into."
        />

        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <Checkbox
            checked={openshellEnabled}
            onCheckedChange={(c) => setOpenshellEnabled(c === true)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-[13px] font-medium text-fg">
              Enable OpenShell
            </span>
            <span className="block text-[12px] text-fg-muted">
              Sets{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                openshell.enabled
              </code>{" "}
              in the chart values. Only meaningful with the{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                openshell
              </code>{" "}
              backend — leaves the{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                local
              </code>{" "}
              path alone.
            </span>
          </span>
        </label>
      </div>

      {/* Generate / revoke token */}
      <div className="rounded-md border border-border bg-bg-surface/50 p-3 space-y-2">
        {!token ? (
          <>
            <p className="text-[12px] text-fg-muted leading-relaxed">
              Generate a multi-use pairing token (24h). It&rsquo;s bound to your
              account — anyone with it can register a machine/cluster on your
              behalf. Revoke it from here the moment it&rsquo;s installed.
            </p>
            <Button
              size="sm"
              onClick={() => void generateToken()}
              disabled={loading || namespace.trim().length === 0}
            >
              {loading ? "Generating…" : "Generate pairing token"}
            </Button>
          </>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[12px] text-fg">
                Token active —{" "}
                <span className="text-fg-muted">
                  {formatExpiry(token.expires_at)}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive h-7 px-2 text-[12px]"
                onClick={() => void revokeToken()}
              >
                Revoke
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Install steps — only render once a token exists, since every block
          references it. Options stay editable so the operator can re-template
          after tweaking namespace/backend. */}
      {token && (
        <div className="space-y-4">
          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              1 · Pairing token
            </div>
            <CopyBlock
              id="k8s-pairing-code"
              text={token.code}
              copied={copied}
              onCopy={onCopy}
            />
            <p className="mt-1.5 text-[11px] text-fg-subtle leading-relaxed">
              Multi-use, {formatExpiry(token.expires_at)}, bound to your
              account. Revoke from this Console.
            </p>
          </div>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              2 · <code className="font-mono">values.yaml</code>
            </div>
            <CopyBlock
              id="k8s-values-yaml"
              text={valuesYaml}
              copied={copied}
              onCopy={onCopy}
            />
          </div>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              3 · Create the namespace + Secret out-of-band
            </div>
            <CopyBlock
              id="k8s-kubectl-secret"
              text={kubectlCmd}
              copied={copied}
              onCopy={onCopy}
            />
            <p className="mt-1.5 text-[11px] text-fg-subtle leading-relaxed">
              The namespace apply is idempotent — safe to re-run on an existing
              cluster. Passing the token via{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                --from-literal
              </code>{" "}
              keeps it out of{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                helm history
              </code>{" "}
              and your shell history.
            </p>
          </div>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              4 · Install the chart
            </div>
            <CopyBlock
              id="k8s-helm-install"
              text={helmCmd}
              copied={copied}
              onCopy={onCopy}
            />
            <p className="mt-1.5 text-[11px] text-fg-subtle leading-relaxed">
              This is the{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                oma-bridge-daemon
              </code>{" "}
              chart — the in-cluster bridge daemon that pairs back to this
              instance. Not{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">
                oma-k8s-bridge
              </code>
              , which is the older Cloudflare→k8s HTTP bridge.
            </p>
          </div>

          <div className="pt-1 border-t border-border flex items-center justify-between gap-2">
            <p className="text-[11px] text-fg-subtle leading-relaxed">
              Full chart reference + troubleshooting:
            </p>
            <div className="flex items-center gap-3 shrink-0">
              <a
                href={CHART_README_URL}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] underline hover:text-brand"
              >
                chart README
              </a>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] underline hover:text-brand"
              >
                docs
              </a>
            </div>
          </div>
        </div>
      )}

      {onDone && (
        <div className="flex justify-end pt-1">
          <Button variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

export function RegisterK8sClusterDialog({
  open,
  onClose,
  copied,
  onCopy,
}: {
  open: boolean;
  onClose: () => void;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register a Kubernetes cluster"
      subtitle="Install the bridge daemon chart and pair it to this instance."
      maxWidth="max-w-2xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <RegisterK8sClusterForm copied={copied} onCopy={onCopy} />
    </Modal>
  );
}
