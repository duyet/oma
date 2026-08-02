// Sandbox-provider logo grid for the Agent Sandbox feature page. Logos come
// from the shared ProviderMark set (same marks the fit diagram and Console
// use); copy stays to one status chip + a single line.
import { ProviderMark } from "@duyet/oma-fit-diagram";

interface Provider {
  id: string;
  name: string;
  status: string;
  line: string;
}

const PROVIDERS: Provider[] = [
  { id: "cloudflare", name: "Cloudflare Containers", status: "default", line: "Zero setup on the Cloudflare deployment." },
  { id: "kubernetes", name: "Kubernetes", status: "self-host", line: "Pod-per-sandbox on your own cluster." },
  { id: "k8s-remote", name: "k8s-remote", status: "cloudflare", line: "In-cluster gateway over plain HTTP." },
  { id: "openshell", name: "NVIDIA OpenShell", status: "cloudflare", line: "Default-deny egress, Landlock FS." },
  { id: "boxrun", name: "BoxRun", status: "cloudflare", line: "Remote boxlite control plane, no SDK." },
  { id: "subprocess", name: "Your machine", status: "bridge relay", line: "`oma bridge daemon` — fastest inner loop." },
  { id: "browser-vm", name: "Browser VM", status: "bridge relay", line: "A WASM VM in your own tab — zero server compute." },
  { id: "docker-compose", name: "Docker Compose", status: "self-host", line: "Containers on any Docker host." },
  { id: "e2b", name: "E2B", status: "self-host", line: "Firecracker micro-VMs, bring your key." },
  { id: "daytona", name: "Daytona", status: "self-host", line: "Managed cloud dev environments." },
  { id: "litebox", name: "LiteBox", status: "self-host", line: "Native micro-VM binding." },
];

export default function SandboxProviderGrid() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {PROVIDERS.map((p) => (
        <article
          key={p.id}
          className="rounded-lg border border-border bg-bg p-4 flex flex-col items-start gap-2 hover:border-border-strong transition-colors"
        >
          <ProviderMark id={p.id} colored className="size-7" />
          <h3 className="font-display text-sm font-semibold tracking-tight leading-tight">{p.name}</h3>
          <span className="text-[10px] font-mono uppercase tracking-wide text-brand">{p.status}</span>
          <p className="text-xs text-fg-muted leading-relaxed">{p.line}</p>
        </article>
      ))}
    </div>
  );
}
