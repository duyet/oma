// Register-a-Kubernetes-cluster flow. Mints a pairing token against
// `POST /v1/runtimes/pairing-token`, then renders install snippets for
// Helm / manual env / GitOps / agent prompt.
//
// Chart: oma-bridge-daemon (in-cluster reverse-WebSocket worker).
// Not oma-k8s-bridge — the older CF→k8s HTTP bridge.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2Icon } from "lucide-react";
import { toast } from "sonner";

import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/form-input";
import { HighlightedCode } from "./HighlightedCode";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { cn } from "@/lib/utils";

interface RuntimeRow {
  id: string;
  hostname?: string;
  status?: string;
}

interface PairingToken {
  code: string;
  state: string;
  expires_at: number;
  kind: "k8s_pairing";
}

type Backend = "subprocess" | "openshell";
type InstallTab = "helm" | "manual" | "gitops" | "prompt";

const DOCS_URL = "https://docs.oma.duyet.net/deploy/bridge-daemon/";
const CHART_README_URL =
  "https://github.com/duyet/oma/blob/main/charts/oma-bridge-daemon/README.md";
const CHART_PATH = "https://github.com/duyet/oma/tree/main/charts/oma-bridge-daemon";
const REPO_URL = "https://github.com/duyet/oma";

function formatExpiry(expiresAtSeconds: number): string {
  const ms = expiresAtSeconds * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 1) return `expires in ~${hours}h ${mins}m`;
  if (mins >= 1) return `expires in ~${mins}m`;
  return "expires in <1m";
}

const BACKENDS: Array<{ id: Backend; title: string; blurb: string }> = [
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
  onConnected,
}: {
  /** @deprecated kept for call-site compat; copy is owned by HighlightedCode */
  copied?: string | null;
  onCopy?: (text: string, key: string) => void;
  onDone?: () => void;
  onConnected?: (runtime: RuntimeRow) => void;
}) {
  const { api } = useApi();
  const [backend, setBackend] = useState<Backend>("subprocess");
  const [namespace, setNamespace] = useState("oma");
  const [token, setToken] = useState<PairingToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<InstallTab>("helm");
  const [, setNow] = useState(0);
  const [connected, setConnected] = useState<RuntimeRow | null>(null);

  // Runtime ids present when the token was minted — only a *new* online
  // id counts as this install succeeding.
  const baselineIdsRef = useRef<Set<string>>(new Set());
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [token]);

  // Poll while a token is live and we haven't seen the new machine yet.
  const runtimesQ = useApiQuery<{ runtimes?: RuntimeRow[] }>(
    "/v1/runtimes",
    undefined,
    {
      enabled: !!token && !connected,
      refetchInterval: 5_000,
      staleTime: 0,
    },
  );

  useEffect(() => {
    if (!token || connected) return;
    const found = (runtimesQ.data?.runtimes ?? []).find(
      (r) => r.status === "online" && r.id && !baselineIdsRef.current.has(r.id),
    );
    if (!found) return;
    setConnected(found);
    toast.success(
      found.hostname ? `Cluster connected: ${found.hostname}` : "Cluster connected",
    );
    onConnectedRef.current?.(found);
  }, [runtimesQ.data, token, connected]);

  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "";
  const ns = namespace.trim() || "oma";
  const openshell = backend === "openshell";

  async function generateToken() {
    setLoading(true);
    try {
      try {
        const existing = await api<{ runtimes?: RuntimeRow[] }>("/v1/runtimes");
        baselineIdsRef.current = new Set(
          (existing.runtimes ?? []).map((r) => r.id).filter(Boolean),
        );
      } catch {
        baselineIdsRef.current = new Set();
      }
      setConnected(null);
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
      await api(`/v1/runtimes/pairing-token/${token.code}`, { method: "DELETE" });
      setToken(null);
      setConnected(null);
      toast.success("Pairing token revoked");
    } catch {
      // api() already toasts.
    }
  }

  const snippets = useMemo(() => {
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
        : [`  # In-pod mode: leave OPENSHELL_* unset. Tools run inside the daemon pod.`]),
    ].join("\n");

    const manualCmd = token
      ? [
          `# 1. Namespace + pairing secret`,
          secretCmd,
          ``,
          `# 2. Apply env ConfigMap`,
          `kubectl apply -f env.yaml`,
          ``,
          `# 3. Deploy daemon manifests`,
          `kubectl apply -f https://raw.githubusercontent.com/duyet/oma/main/deploy/cli-bridge-daemon/`,
        ].join("\n")
      : "";

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
      `    automated: { prune: true, selfHeal: true }`,
      `    syncOptions: ["CreateNamespace=true"]`,
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
      `  ref: { branch: main }`,
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
          `# Create pairing secret OUTSIDE Git. Never commit OMA_PAIRING_*.`,
          secretCmd,
        ].join("\n")
      : "";

    const agentPrompt = buildAgentPrompt({
      serverUrl,
      ns,
      openshell,
      token,
      valuesYaml,
      secretCmd,
      helmCmd,
    });

    return {
      valuesYaml,
      secretCmd,
      helmCmd,
      envYaml,
      manualCmd,
      argoApp,
      fluxHelm,
      gitopsSecretHint,
      agentPrompt,
    };
  }, [serverUrl, ns, openshell, token]);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[12px] text-fg-muted leading-relaxed">
        Install{" "}
        <span className="text-fg font-medium">oma-bridge-daemon</span> in your
        cluster. It opens an outbound WebSocket to this OMA instance and shows
        up under <span className="text-fg">Connected machines</span>. Route
        work with an environment whose sandbox provider is{" "}
        <code className="rounded bg-bg-surface px-1 font-mono text-[11px]">
          subprocess
        </code>
        .
      </p>

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

      <div className="space-y-2.5 pt-1">
        <div className="text-[12px] font-medium text-fg">Install method</div>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as InstallTab)}
          className="w-full flex flex-col gap-2.5"
        >
          <TabsList className="grid w-full grid-cols-4 h-9">
            <TabsTrigger value="helm" className="text-[12px]">
              Helm
            </TabsTrigger>
            <TabsTrigger value="manual" className="text-[12px]">
              Manual / env
            </TabsTrigger>
            <TabsTrigger value="gitops" className="text-[12px]">
              GitOps
            </TabsTrigger>
            <TabsTrigger value="prompt" className="text-[12px]">
              Prompt
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
          </TabsContent>

          <TabsContent value="gitops" className="space-y-2.5 mt-0 outline-none">
            <p className="text-[11px] text-fg-muted leading-snug">
              Keep pairing secrets out of Git. Create the secret with kubectl
              (or ExternalSecrets), then sync the chart with Argo CD or Flux.
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

          <TabsContent value="prompt" className="space-y-2.5 mt-0 outline-none">
            <p className="text-[11px] text-fg-muted leading-snug">
              Paste into Claude Code, Cursor, or Codex on a machine with{" "}
              <code className="font-mono text-[10px]">kubectl</code> /{" "}
              <code className="font-mono text-[10px]">helm</code> for this
              cluster.
            </p>
            {!token && (
              <div className="rounded-md border border-dashed border-border bg-bg px-3 py-2.5 text-[11px] text-fg-muted">
                Generate a pairing token above so the prompt includes real{" "}
                <code className="font-mono text-[10px]">OMA_PAIRING_*</code>{" "}
                values.
              </div>
            )}
            <HighlightedCode
              code={snippets.agentPrompt}
              language="text"
              filename="agent-install-prompt.md"
              maxHeightClass="max-h-80"
            />
          </TabsContent>
        </Tabs>
      </div>

      {(token || connected) && (
        <div
          className={cn(
            "rounded-md border px-3 py-2.5 flex items-start gap-2.5",
            connected
              ? "border-success/40 bg-success/5"
              : "border-border bg-bg-surface/60",
          )}
        >
          {connected ? (
            <CheckCircle2Icon className="size-4 text-success shrink-0 mt-0.5" />
          ) : (
            <Spinner className="size-4 text-brand shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="text-[12px] font-medium text-fg">
              {connected
                ? `Cluster connected${connected.hostname ? `: ${connected.hostname}` : ""}`
                : "Waiting for cluster to connect…"}
            </div>
            <p className="text-[11px] text-fg-muted leading-snug">
              {connected
                ? "It appears under Connected machines. You can close this dialog."
                : "Safe to close — after install and pair succeed, the cluster shows up automatically under Connected machines."}
            </p>
          </div>
        </div>
      )}

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
            {connected ? "Close" : "Done"}
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

/** Short paste-ready brief for a coding agent with cluster access. */
function buildAgentPrompt(args: {
  serverUrl: string;
  ns: string;
  openshell: boolean;
  token: PairingToken | null;
  valuesYaml: string;
  secretCmd: string;
  helmCmd: string;
}): string {
  const { serverUrl, ns, openshell, token, valuesYaml, secretCmd, helmCmd } =
    args;
  const backend = openshell
    ? "openshell (per-session sandboxes)"
    : "subprocess / in-pod (default)";
  const secret = token
    ? secretCmd
    : [
        `kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -`,
        `kubectl create secret generic oma-bridge-daemon-pairing -n ${ns} \\`,
        `  --from-literal=OMA_PAIRING_CODE='<FROM_CONSOLE>' \\`,
        `  --from-literal=OMA_PAIRING_STATE='<FROM_CONSOLE>' \\`,
        `  --dry-run=client -o yaml | kubectl apply -f -`,
      ].join("\n");

  return [
    `# Install OMA bridge daemon on the current Kubernetes cluster`,
    ``,
    `Use kubectl/helm on the current context. Install **oma-bridge-daemon**`,
    `(NOT oma-k8s-bridge). Pair outbound to the OMA control plane.`,
    ``,
    `## Parameters`,
    `- OMA server: ${serverUrl || "(console origin)"}`,
    `- Namespace: ${ns}`,
    `- Backend: ${backend}`,
    `- Chart: ${REPO_URL} → charts/oma-bridge-daemon`,
    `- Docs: ${DOCS_URL}`,
    token
      ? [
          `- OMA_PAIRING_CODE: ${token.code}`,
          `- OMA_PAIRING_STATE: ${token.state}`,
          `- Do not invent codes; do not commit them.`,
        ].join("\n")
      : `- No token embedded — ask the human to Generate token in Console first.`,
    ``,
    `## Helm steps`,
    ``,
    `### 1. Pairing secret`,
    "```bash",
    secret,
    "```",
    ``,
    `### 2. values.yaml`,
    "```yaml",
    valuesYaml,
    "```",
    ``,
    `### 3. Install`,
    "```bash",
    `git clone --depth 1 ${REPO_URL}.git /tmp/oma && cd /tmp/oma`,
    helmCmd,
    "```",
    ``,
    `### 4. Verify`,
    "```bash",
    `kubectl -n ${ns} get pods -l app.kubernetes.io/name=oma-bridge-daemon`,
    `kubectl -n ${ns} logs -l app.kubernetes.io/name=oma-bridge-daemon --tail=80`,
    "```",
    ``,
    `## Success`,
    `Pod Ready; logs show pair/connect; Console → Connected machines online.`,
    `Report resources applied and any errors. Don't change unrelated cluster state.`,
  ].join("\n");
}

export function RegisterK8sClusterDialog({
  open,
  onClose,
  copied,
  onCopy,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  copied?: string | null;
  onCopy?: (text: string, key: string) => void;
  onConnected?: (runtime: RuntimeRow) => void;
}) {
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Register a Kubernetes cluster"
      subtitle="Deploy oma-bridge-daemon and pair it to this instance."
      maxWidth="max-w-2xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {open ? (
        <RegisterK8sClusterForm
          key="register-k8s-open"
          copied={copied}
          onCopy={onCopy}
          onDone={onClose}
          onConnected={onConnected}
        />
      ) : null}
    </FormDialog>
  );
}
