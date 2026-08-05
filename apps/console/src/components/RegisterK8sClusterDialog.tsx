// Register-a-Kubernetes-cluster flow. Mints a pairing token against
// `POST /v1/runtimes/pairing-token`, then renders install snippets for
// Helm / manual env / GitOps, templated from the chosen backend + namespace.
//
// Two exports:
//   - <RegisterK8sClusterForm /> — the inner content.
//   - <RegisterK8sClusterDialog /> — Modal wrapper opened from Runtimes.
//
// The chart is `oma-bridge-daemon` (in-cluster reverse-WebSocket worker).
// Not `oma-k8s-bridge` — the older CF→k8s HTTP bridge.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { TextInput } from "./Input";
import { HighlightedCode } from "./HighlightedCode";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "../lib/api";
import { cn } from "@/lib/utils";

interface PairingToken {
  code: string;
  state: string;
  expires_at: number;
  kind: "k8s_pairing";
}

/**
 * How the in-cluster daemon executes sandbox ops.
 *
 * - `subprocess` — tools run **inside the daemon pod** (no extra pods).
 * - `openshell`  — daemon relays each session to an OpenShell gateway that
 *                  creates isolated sandboxes (pods/microVMs) per session.
 */
type Backend = "subprocess" | "openshell";

type InstallTab = "helm" | "manual" | "gitops";

const DOCS_URL = "https://docs.oma.duyet.net/deploy/bridge-daemon/";
const CHART_README_URL =
  "https://github.com/duyet/oma/blob/main/charts/oma-bridge-daemon/README.md";
const CHART_PATH = "https://github.com/duyet/oma/tree/main/charts/oma-bridge-daemon";

function formatExpiry(expiresAtSeconds: number): string {
  const ms = expiresAtSeconds * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 1) return `expires in ~${hours}h ${mins}m`;
  if (mins >= 1) return `expires in ~${mins}m`;
  return "expires in <1m";
}

const BACKENDS: Array<{
  id: Backend;
  title: string;
  blurb: string;
}> = [
  {
    id: "subprocess",
    title: "In-pod (default)",
    blurb:
      "bash/read/write run inside the daemon pod. One Deployment — no extra pods per session.",
  },
  {
    id: "openshell",
    title: "OpenShell",
    blurb:
      "Daemon relays each session to an OpenShell gateway, which spins an isolated sandbox per turn.",
  },
];

export function RegisterK8sClusterForm({
  onDone,
}: {
  /** @deprecated kept for call-site compat; copy is owned by HighlightedCode */
  copied?: string | null;
  onCopy?: (text: string, key: string) => void;
  onDone?: () => void;
}) {
  const { api } = useApi();
  const [backend, setBackend] = useState<Backend>("subprocess");
  const [namespace, setNamespace] = useState("oma");
  const [token, setToken] = useState<PairingToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<InstallTab>("helm");
  const [, setNow] = useState(0);

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [token]);

  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  const ns = namespace.trim() || "oma";
  const openshell = backend === "openshell";

  async function generateToken() {
    setLoading(true);
    try {
      const res = await api<PairingToken>("/v1/runtimes/pairing-token", {
        method: "POST",
        body: JSON.stringify({ ttl_hours: 24 }),
      });
      setToken(res);
    } catch {
      // api() already toasts.
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

  const snippets = useMemo(() => {
    // Chart values: empty bridge.backend = subprocess default; "openshell"
    // + openshell.enabled installs the gateway subchart.
    const valuesYaml = [
      `pairing:`,
      `  existingSecret: oma-bridge-daemon-pairing`,
      `  serverUrl: ${serverUrl}`,
      `bridge:`,
      `  # "" = in-pod subprocess; "openshell" = per-session isolated sandboxes`,
      `  backend: ${openshell ? "openshell" : '""'}`,
      `  namespace: ${ns}`,
      `openshell:`,
      `  enabled: ${openshell ? "true" : "false"}`,
    ].join("\n");

    const secretCmd = token
      ? [
          `kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -`,
          `kubectl create secret generic oma-bridge-daemon-pairing \\`,
          `  --namespace ${ns} \\`,
          `  --from-literal=OMA_PAIRING_CODE='${token.code}' \\`,
          `  --from-literal=OMA_PAIRING_STATE='${token.state}' \\`,
          `  --dry-run=client -o yaml | kubectl apply -f -`,
        ].join("\n")
      : "";

    const helmCmd = [
      `# From a clone of github.com/duyet/oma`,
      `helm dependency build ./charts/oma-bridge-daemon`,
      `helm upgrade --install oma-bridge-daemon ./charts/oma-bridge-daemon \\`,
      `  --namespace ${ns} \\`,
      `  -f values.yaml`,
    ].join("\n");

    // Manual path: secret + ConfigMap env + pointer to raw manifests.
    const envYaml = [
      `apiVersion: v1`,
      `kind: ConfigMap`,
      `metadata:`,
      `  name: oma-bridge-daemon-config`,
      `  namespace: ${ns}`,
      `data:`,
      `  OMA_SERVER_URL: "${serverUrl}"`,
      `  BRIDGE_SANDBOX_BACKEND: "${openshell ? "openshell" : "subprocess"}"`,
      ...(openshell
        ? [
            `  # Point at your in-cluster OpenShell gateway (adjust host/port).`,
            `  OPENSHELL_GATEWAY_ENDPOINT: "openshell-gateway.${ns}.svc.cluster.local:8080"`,
          ]
        : [
            `  # In-pod mode: leave OPENSHELL_* unset. Tools run inside the daemon pod.`,
          ]),
    ].join("\n");

    const manualCmd = token
      ? [
          `# 1. Namespace + pairing secret (token stays out of helm history)`,
          secretCmd,
          ``,
          `# 2. Apply env ConfigMap (copy env.yaml below first)`,
          `kubectl apply -f env.yaml`,
          ``,
          `# 3. Deploy the daemon manifests`,
          `kubectl apply -f https://raw.githubusercontent.com/duyet/oma/main/deploy/cli-bridge-daemon/`,
          `#    or: kubectl apply -f deploy/cli-bridge-daemon/  (from a local clone)`,
        ].join("\n")
      : "";

    // GitOps-friendly values (no secret literals — ExternalSecret / SealedSecrets).
    const argoApp = [
      `apiVersion: argoproj.io/v1alpha1`,
      `kind: Application`,
      `metadata:`,
      `  name: oma-bridge-daemon`,
      `  namespace: argocd`,
      `spec:`,
      `  project: default`,
      `  source:`,
      `    repoURL: https://github.com/duyet/oma.git`,
      `    path: charts/oma-bridge-daemon`,
      `    targetRevision: main`,
      `    helm:`,
      `      values: |`,
      `        pairing:`,
      `          existingSecret: oma-bridge-daemon-pairing`,
      `          serverUrl: ${serverUrl}`,
      `        bridge:`,
      `          backend: ${openshell ? "openshell" : '""'}`,
      `          namespace: ${ns}`,
      `        openshell:`,
      `          enabled: ${openshell ? "true" : "false"}`,
      `  destination:`,
      `    server: https://kubernetes.default.svc`,
      `    namespace: ${ns}`,
      `  syncPolicy:`,
      `    automated:`,
      `      prune: true`,
      `      selfHeal: true`,
      `    syncOptions:`,
      `      - CreateNamespace=true`,
    ].join("\n");

    const fluxHelm = [
      `apiVersion: source.toolkit.fluxcd.io/v1`,
      `kind: GitRepository`,
      `metadata:`,
      `  name: oma`,
      `  namespace: flux-system`,
      `spec:`,
      `  interval: 10m`,
      `  url: https://github.com/duyet/oma.git`,
      `  ref:`,
      `    branch: main`,
      `---`,
      `apiVersion: helm.toolkit.fluxcd.io/v2`,
      `kind: HelmRelease`,
      `metadata:`,
      `  name: oma-bridge-daemon`,
      `  namespace: ${ns}`,
      `spec:`,
      `  interval: 10m`,
      `  chart:`,
      `    spec:`,
      `      chart: charts/oma-bridge-daemon`,
      `      sourceRef:`,
      `        kind: GitRepository`,
      `        name: oma`,
      `        namespace: flux-system`,
      `  values:`,
      `    pairing:`,
      `      existingSecret: oma-bridge-daemon-pairing`,
      `      serverUrl: ${serverUrl}`,
      `    bridge:`,
      `      backend: ${openshell ? "openshell" : '""'}`,
      `      namespace: ${ns}`,
      `    openshell:`,
      `      enabled: ${openshell}`,
    ].join("\n");

    const gitopsSecretHint = token
      ? [
          `# Create the pairing secret OUTSIDE Git (or via ExternalSecrets).`,
          `# Never commit OMA_PAIRING_CODE / OMA_PAIRING_STATE.`,
          secretCmd,
        ].join("\n")
      : "";

    return {
      valuesYaml,
      secretCmd,
      helmCmd,
      envYaml,
      manualCmd,
      argoApp,
      fluxHelm,
      gitopsSecretHint,
    };
  }, [serverUrl, ns, openshell, token]);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[12px] text-fg-muted leading-relaxed">
        Install{" "}
        <span className="text-fg font-medium">oma-bridge-daemon</span> in your
        cluster. It opens an outbound WebSocket to this OMA instance and shows
        up under{" "}
        <span className="text-fg">Connected machines</span>. Route work with an
        environment whose sandbox provider is{" "}
        <code className="rounded bg-bg-surface px-1 font-mono text-[11px]">
          subprocess
        </code>
        .
      </p>

      {/* Backend as compact radio cards — labels describe the real model. */}
      <div className="space-y-1.5">
        <div className="text-[12px] font-medium text-fg">Where sandboxes run</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {BACKENDS.map((b) => {
            const selected = backend === b.id;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => setBackend(b.id)}
                className={cn(
                  "text-left rounded-md border px-2.5 py-2 transition-colors",
                  selected
                    ? "border-brand bg-brand/5 ring-1 ring-brand/30"
                    : "border-border hover:border-border-strong bg-bg-surface/40",
                )}
              >
                <div className="text-[12px] font-medium text-fg">{b.title}</div>
                <div className="text-[11px] text-fg-muted leading-snug mt-0.5">
                  {b.blurb}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <TextInput
        label="Namespace"
        placeholder="oma"
        value={namespace}
        onChange={(e) => setNamespace(e.target.value)}
        hint="Kubernetes namespace for the daemon Deployment."
      />

      {/* Pairing token */}
      <div className="rounded-md border border-border bg-bg-surface/50 px-3 py-2.5 space-y-2">
        {!token ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-fg-muted leading-snug flex-1 min-w-0">
              Multi-use pairing token (24h), bound to your account. Generate
              first — install steps need it.
            </p>
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => void generateToken()}
              disabled={loading || ns.length === 0}
            >
              {loading ? "Generating…" : "Generate token"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] text-fg font-medium">Token ready</div>
              <div className="text-[11px] text-fg-muted">
                {formatExpiry(token.expires_at)} · multi-use · revoke after install
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive h-7 px-2 text-[12px] shrink-0"
              onClick={() => void revokeToken()}
            >
              Revoke
            </Button>
          </div>
        )}
      </div>

      {/* Install method — tabs always on top of the install section.
          Content is usable before a token (values / env / GitOps); secret
          steps show a short prompt until Generate token is clicked. */}
      <div className="space-y-2.5 pt-1">
        <div className="text-[12px] font-medium text-fg">Install method</div>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as InstallTab)}
          className="w-full flex flex-col gap-2.5"
        >
          <TabsList className="grid w-full grid-cols-3 h-9">
            <TabsTrigger value="helm" className="text-[12px]">
              Helm
            </TabsTrigger>
            <TabsTrigger value="manual" className="text-[12px]">
              Manual / env
            </TabsTrigger>
            <TabsTrigger value="gitops" className="text-[12px]">
              GitOps
            </TabsTrigger>
          </TabsList>

          <TabsContent value="helm" className="space-y-2.5 mt-0 outline-none">
            <Step n={1} title="Pairing secret">
              {token ? (
                <HighlightedCode
                  code={snippets.secretCmd}
                  language="bash"
                  filename="create-pairing-secret.sh"
                  maxHeightClass="max-h-40"
                />
              ) : (
                <TokenNeeded />
              )}
            </Step>
            <Step n={2} title="values.yaml">
              <HighlightedCode
                code={snippets.valuesYaml}
                language="yaml"
                filename="values.yaml"
                maxHeightClass="max-h-48"
              />
            </Step>
            <Step n={3} title="Install chart">
              <HighlightedCode
                code={snippets.helmCmd}
                language="bash"
                filename="helm-install.sh"
                maxHeightClass="max-h-40"
              />
              <p className="text-[11px] text-fg-subtle leading-snug mt-1">
                Chart:{" "}
                <a
                  href={CHART_PATH}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-brand"
                >
                  charts/oma-bridge-daemon
                </a>
                . Not{" "}
                <code className="font-mono text-[10px]">oma-k8s-bridge</code>.
              </p>
            </Step>
          </TabsContent>

          <TabsContent value="manual" className="space-y-2.5 mt-0 outline-none">
            <Step n={1} title="Env ConfigMap">
              <HighlightedCode
                code={snippets.envYaml}
                language="yaml"
                filename="env.yaml"
                maxHeightClass="max-h-48"
              />
            </Step>
            <Step n={2} title="Apply secret + manifests">
              {token ? (
                <HighlightedCode
                  code={snippets.manualCmd}
                  language="bash"
                  filename="manual-deploy.sh"
                  maxHeightClass="max-h-56"
                />
              ) : (
                <TokenNeeded />
              )}
            </Step>
            <p className="text-[11px] text-fg-subtle leading-snug">
              Copy-paste env for a hand-rolled Deployment: set{" "}
              <code className="font-mono text-[10px]">BRIDGE_SANDBOX_BACKEND</code>{" "}
              to{" "}
              <code className="font-mono text-[10px]">
                {openshell ? "openshell" : "subprocess"}
              </code>
              {openshell
                ? " and OPENSHELL_GATEWAY_ENDPOINT to your gateway host:port."
                : ". Tools share the daemon pod — no per-session pods."}
            </p>
          </TabsContent>

          <TabsContent value="gitops" className="space-y-2.5 mt-0 outline-none">
            <p className="text-[11px] text-fg-muted leading-snug">
              Keep pairing secrets out of Git. Create the secret with kubectl
              (or ExternalSecrets / Sealed Secrets), then sync the chart with
              Argo CD or Flux.
            </p>
            <Step n={1} title="Pairing secret (out-of-band)">
              {token ? (
                <HighlightedCode
                  code={snippets.gitopsSecretHint}
                  language="bash"
                  filename="pairing-secret.sh"
                  maxHeightClass="max-h-40"
                />
              ) : (
                <TokenNeeded />
              )}
            </Step>
            <Step n={2} title="Argo CD Application">
              <HighlightedCode
                code={snippets.argoApp}
                language="yaml"
                filename="argocd-application.yaml"
                maxHeightClass="max-h-56"
              />
            </Step>
            <Step n={3} title="Flux HelmRelease (alt)">
              <HighlightedCode
                code={snippets.fluxHelm}
                language="yaml"
                filename="flux-helmrelease.yaml"
                maxHeightClass="max-h-56"
              />
            </Step>
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border">
        <div className="flex items-center gap-3 text-[11px]">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-brand text-fg-subtle"
          >
            Docs
          </a>
          <a
            href={CHART_README_URL}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-brand text-fg-subtle"
          >
            Chart README
          </a>
        </div>
        {onDone && (
          <Button variant="ghost" size="sm" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] text-fg-subtle mb-1 font-medium">
        <span className="font-mono text-fg-muted">{n}.</span> {title}
      </div>
      {children}
    </div>
  );
}

function TokenNeeded() {
  return (
    <div className="rounded-md border border-dashed border-border bg-bg px-3 py-2.5 text-[11px] text-fg-muted">
      Generate a pairing token above to fill in the secret command.
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
  copied?: string | null;
  onCopy?: (text: string, key: string) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register a Kubernetes cluster"
      subtitle="Deploy oma-bridge-daemon and pair it to this instance."
      maxWidth="max-w-2xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <RegisterK8sClusterForm copied={copied} onCopy={onCopy} />
    </Modal>
  );
}
