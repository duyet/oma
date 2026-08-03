import { useState } from "react";

import { useApi } from "../lib/api";
import { useApiMutation } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "../components/Select";
import { TextInput, SecretInput } from "../components/Input";

// The console doesn't bundle @getoma/sandbox-sdk, so we mirror the
// provider→env mapping that `providerConfigToEnv` applies server-side
// (apps/main-node + packages/sandbox-sdk). Each BYOK-able provider declares
// the fields it needs; on submit we fold them into the
// `{ type, label, apiKey, baseURL, config }` shape the Node route expects.
type FieldTarget = "apiKey" | "baseURL" | { configKey: string };

interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  /** config bucket key (uppercased at the boundary by the server). */
  target: FieldTarget;
}

interface ProviderSchema {
  type: string;
  label: string;
  blurb: string;
  fields: ProviderField[];
}

const PROVIDERS: ProviderSchema[] = [
  {
    type: "boxrun",
    label: "BoxRun (remote micro-VM)",
    blurb: "Talks to a remote BoxLite HTTP control plane — no local KVM needed.",
    fields: [
      { key: "url", label: "BoxRun URL", placeholder: "https://boxlite.example.com", target: "baseURL" },
      { key: "token", label: "BoxRun Token", placeholder: "br_…", secret: true, target: "apiKey" },
    ],
  },
  {
    type: "daytona",
    label: "Daytona",
    blurb: "Daytona SaaS — a managed Linux VM per session.",
    fields: [
      { key: "url", label: "Daytona API URL", placeholder: "https://api.daytona.io", target: "baseURL" },
      { key: "token", label: "Daytona API Key", placeholder: "dtn…", secret: true, target: "apiKey" },
    ],
  },
  {
    type: "e2b",
    label: "E2B",
    blurb: "E2B Firecracker microVM per session (~250ms cold from a warm pool).",
    fields: [
      { key: "url", label: "E2B API URL", placeholder: "https://api.e2b.dev", target: "baseURL" },
      { key: "token", label: "E2B API Key", placeholder: "e2b_…", secret: true, target: "apiKey" },
    ],
  },
  {
    type: "k8s-bridge",
    label: "K8s Bridge (remote)",
    blurb: "Remote sandbox via HTTP bridge to a Kubernetes cluster.",
    fields: [
      { key: "url", label: "Bridge URL", placeholder: "https://k8s-bridge.example.com", target: "baseURL" },
      { key: "token", label: "Bridge Token", placeholder: "…", secret: true, target: "apiKey" },
    ],
  },
  {
    type: "remote-agent",
    label: "Remote Agent (BYOK)",
    blurb: "BYOK remote machine sandbox via a lightweight HTTP agent.",
    fields: [
      { key: "url", label: "Agent URL", placeholder: "https://agent.example.com", target: "baseURL" },
      { key: "token", label: "Agent Token", placeholder: "…", secret: true, target: "apiKey" },
    ],
  },
  {
    type: "openshell",
    label: "NVIDIA OpenShell",
    blurb: "NVIDIA OpenShell gateway (gRPC) — policy-enforced isolated sandboxes.",
    fields: [
      { key: "url", label: "Gateway Endpoint", placeholder: "grpc://openshell.example.com:50051", target: "baseURL" },
      { key: "token", label: "Gateway Token", placeholder: "…", secret: true, target: "apiKey" },
    ],
  },
  {
    type: "github-actions",
    label: "GitHub Actions",
    blurb: "Run sandbox commands via a GitHub Actions workflow_dispatch.",
    fields: [
      { key: "token", label: "GitHub Token", placeholder: "ghp_…", secret: true, target: "apiKey" },
      { key: "url", label: "GitHub API Base URL", placeholder: "https://api.github.com", hint: "Leave default unless using GitHub Enterprise.", target: "baseURL" },
      { key: "owner", label: "Owner", placeholder: "octocat", target: { configKey: "GITHUB_ACTIONS_OWNER" } },
      { key: "repo", label: "Repo", placeholder: "my-runners", target: { configKey: "GITHUB_ACTIONS_REPO" } },
      { key: "workflow", label: "Workflow file", placeholder: "sandbox.yml", target: { configKey: "GITHUB_ACTIONS_WORKFLOW" } },
    ],
  },
  {
    type: "docker-compose",
    label: "Docker Compose",
    blurb: "Per-session Docker Compose sandbox. Requires a Docker socket on the host.",
    fields: [
      { key: "url", label: "Project Dir", placeholder: "/opt/oma/compose", hint: "Absolute path to the directory holding docker-compose.yml.", target: "baseURL" },
    ],
  },
  {
    type: "k8s",
    label: "Kubernetes",
    blurb: "Pod provisioned via the kubernetes-sigs agent-sandbox controller.",
    fields: [
      { key: "namespace", label: "Namespace", placeholder: "oma-sandbox", target: { configKey: "OMA_K8S_NAMESPACE" } },
    ],
  },
  {
    type: "litebox",
    label: "LiteBox (local micro-VM)",
    blurb: "Local Firecracker micro-VM per box. Hardware isolation, no daemon.",
    fields: [
      { key: "memory", label: "Memory (MiB)", placeholder: "2048", hint: "Optional — defaults apply when omitted.", target: { configKey: "LITEBOX_MEMORY_MIB" } },
      { key: "cpu", label: "vCPU", placeholder: "2", target: { configKey: "LITEBOX_CPU" } },
    ],
  },
];

const PROVIDER_BY_TYPE = new Map(PROVIDERS.map((p) => [p.type, p]));

export { PROVIDERS, PROVIDER_BY_TYPE };

interface SandboxProviderFormFieldsProps {
  onCreated: () => void;
  onDone?: () => void;
}

export function SandboxProviderFormFields({
  onCreated,
  onDone,
}: SandboxProviderFormFieldsProps) {
  const { api } = useApi();
  const [selectedType, setSelectedType] = useState(PROVIDERS[0].type);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  const schema = PROVIDER_BY_TYPE.get(selectedType) ?? PROVIDERS[0];

  const mutation = useApiMutation<{ data: unknown }>({
    onSuccess: () => {
      onCreated();
      reset();
      onDone?.();
    },
  });

  function reset() {
    setSelectedType(PROVIDERS[0].type);
    setLabel("");
    setDescription("");
    setValues({});
  }

  function handleProviderChange(type: string) {
    setSelectedType(type);
    setValues({});
  }

  const canSubmit = label.trim().length > 0 && mutation.status !== "pending";

  async function handleSubmit() {
    if (!label.trim()) return;

    const body: {
      type: string;
      label: string;
      description?: string;
      apiKey?: string;
      baseURL?: string;
      config?: Record<string, string>;
    } = { type: schema.type, label: label.trim() };

    if (description.trim()) body.description = description.trim();

    const config: Record<string, string> = {};
    for (const f of schema.fields) {
      const v = (values[f.key] ?? "").trim();
      if (!v) continue;
      if (f.target === "apiKey") body.apiKey = v;
      else if (f.target === "baseURL") body.baseURL = v;
      else config[f.target.configKey] = v;
    }
    if (Object.keys(config).length > 0) body.config = config;

    await mutation.mutateAsync({ path: "/v1/sandbox_providers", method: "POST", body });
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[13px] font-medium text-fg mb-1.5">Provider type</label>
        <Select value={selectedType} onValueChange={handleProviderChange}>
          {PROVIDERS.map((p) => (
            <SelectOption key={p.type} value={p.type}>
              {p.label}
            </SelectOption>
          ))}
        </Select>
        <p className="mt-1 text-[12px] text-fg-muted">{schema.blurb}</p>
      </div>

      <TextInput
        label="Label"
        placeholder="My Daytona account"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      <TextInput
        label="Description"
        hint="Optional — shown on the provider card."
        placeholder="Production sandbox pool"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      {schema.fields.map((f) =>
        f.secret ? (
          <SecretInput
            key={f.key}
            label={f.label}
            hint={f.hint}
            placeholder={f.placeholder}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        ) : (
          <TextInput
            key={f.key}
            label={f.label}
            hint={f.hint}
            placeholder={f.placeholder}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        ),
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {onDone && (
          <Button variant="ghost" onClick={onDone} disabled={mutation.status === "pending"}>
            Cancel
          </Button>
        )}
        <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {mutation.status === "pending" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

