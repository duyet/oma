// Platform guidance appended to every agent's system prompt. Single source
// of truth — both CF SessionDO and the self-host Node main read these.
// Keep additions surgical: every line is sent on every turn for every
// agent, so it sits on the prompt-cache prefix path. Don't expand without
// proportional benefit.

import type { EnvironmentConfig } from "@duyet/oma-api-types";

export const authenticatedCommandGuidance =
  "For commands that may require authentication, prefer issuing a single command instead of a chained shell command. If an authenticated chained command fails, retry with a simpler single-command form.";

// Loop-stop guidance: prod incidents have shown agents retrying the same
// failing tool call indefinitely when an upstream credential is missing or
// an external API is down. Cap retries explicitly and require a structured
// failure report so the human (or calling system) can intervene.
export const loopStopGuidance =
  "If the same tool call fails three times in a row with substantively the same error, stop retrying. Report (a) what you were trying to do, (b) the exact error, and (c) what you would need to make progress (a missing credential, a corrected input, an upstream service to recover), then end the turn instead of looping.";

// AMA-aligned `/mnt/session/outputs/` convention: the platform mounts a
// per-session R2-backed (or host-fs-backed on Node) directory at this path.
// Files written here are listable via GET /v1/sessions/:id/outputs and
// downloadable by the caller. Without this hint, agents historically wrote
// final artefacts to /workspace/ where they vanish on container recycle.
export const sessionOutputsGuidance =
  "Files you write under `/mnt/session/outputs/` persist after the session ends and are downloadable by the user from the session's Files panel. Use this path for final artifacts the user should keep (reports, exports, generated docs, packaged code). Files written anywhere else (e.g. `/workspace/`) are scratch — they may be lost on container recycle and are not user-accessible.";

export const platformGuidance =
  `${authenticatedCommandGuidance}\n\n${loopStopGuidance}\n\n${sessionOutputsGuidance}`;

/** Minimal environment shape the sandbox-env block needs — full EnvironmentConfig
 *  or a partial snapshot both work. */
export type SandboxEnvInfo = Pick<EnvironmentConfig, "id" | "name" | "description"> & {
  config?: EnvironmentConfig["config"] | null;
};

const PROVIDER_NOTES: Record<string, string> = {
  cloud:
    "Managed Cloudflare Containers sandbox. Full Linux shell; credentials for outbound HTTP are injected by the platform proxy (never visible in the sandbox).",
  cloudflare:
    "Managed Cloudflare Containers sandbox. Full Linux shell; credentials for outbound HTTP are injected by the platform proxy (never visible in the sandbox).",
  "browser-vm":
    "Sandbox runs as a WASM VM inside a user's browser tab (`/sandbox-tab`). No inbound SSH/TCP. Keep that tab open (background is OK); closing it takes the sandbox offline. Prefer simple single-line commands over interactive tools (vim, password prompts).",
  subprocess:
    "Sandbox ops relay to a paired machine via the bridge daemon (`oma bridge`). Files and tools are those of the host machine. No separate container isolation.",
  local:
    "Sandbox ops relay to a paired machine via the bridge daemon (`oma bridge`). Files and tools are those of the host machine.",
  "oma-remote":
    "This session has no local sandbox — the turn is proxied to another OMA instance that owns the sandbox, tools, and vault.",
  e2b: "Ephemeral E2B Firecracker microVM. Fast cold start; state does not survive the session.",
  daytona: "Daytona cloud dev environment. Session-scoped workspace.",
  boxrun: "Remote BoxRun (BoxLite) micro-VM control plane.",
  litebox: "Local Firecracker micro-VM (LiteBox) on the host.",
  k8s: "Kubernetes pod sandbox (agent-sandbox controller).",
  kubernetes: "Kubernetes pod sandbox (agent-sandbox controller).",
  "k8s-remote": "Remote Kubernetes sandbox via the k8s-sandbox-gateway HTTP API.",
  "k8s-bridge": "Remote sandbox via k8s-bridge HTTP API.",
  openshell: "NVIDIA OpenShell gateway sandbox (policy-enforced isolation).",
  "docker-compose": "Per-session Docker Compose project on the host.",
  "dynamic-workers":
    "Cloudflare Dynamic Worker (V8 isolate) eval only — no shell, no filesystem, nothing persists between calls.",
  "github-actions": "Sandbox commands run via a GitHub Actions workflow_dispatch runner.",
  "remote-agent": "BYOK remote machine sandbox via a lightweight HTTP agent.",
};

/**
 * Byte-deterministic sandbox / environment block for the system prompt.
 * Tells the model which provider it is on, the filesystem layout, networking,
 * packages, and provider-specific constraints. Returns null when there is
 * nothing useful to say (no env) so callers can omit the block entirely.
 *
 * Field order and package sorting are fixed so Anthropic's prompt cache is
 * not busted by object key order or package array shuffle.
 */
export function buildSandboxEnvironmentGuidance(
  env?: SandboxEnvInfo | null,
): string | null {
  if (!env) return null;
  const cfg = env.config ?? undefined;
  const provider =
    (cfg?.sandbox_provider || cfg?.type || "cloud").trim() || "cloud";
  const kind = cfg?.kind === "local" ? "local" : "cloud";
  const lines: string[] = [
    "## Sandbox environment",
    "You execute tools inside a managed sandbox for this session. Facts below are authoritative for this turn.",
    "",
    `- **Environment**: ${env.name || env.id}${env.id ? ` (\`${env.id}\`)` : ""}`,
  ];
  if (env.description?.trim()) {
    lines.push(`- **Description**: ${env.description.trim()}`);
  }
  lines.push(`- **Sandbox provider**: \`${provider}\``);
  lines.push(
    kind === "local"
      ? "- **Execution kind**: local (agent loop on a paired machine / ACP runtime)"
      : "- **Execution kind**: cloud (tools run in the sandbox provider above)",
  );

  // Paths — stable for every provider that exposes a Linux-like FS.
  if (provider !== "dynamic-workers" && provider !== "oma-remote") {
    lines.push("- **Working directory**: `/workspace` (scratch; may be lost when the sandbox is recycled)");
    lines.push(
      "- **Session outputs**: `/mnt/session/outputs/` (persist after the session; user-downloadable)",
    );
    lines.push(
      "- **Memory stores** (when attached): `/mnt/memory/<store_name>/` — use normal file tools",
    );
    lines.push(
      "- **Skills** (when mounted): `/home/user/.skills/` — read on demand",
    );
  }

  if (cfg?.networking) {
    if (cfg.networking.type === "limited") {
      const hosts = [...(cfg.networking.allowed_hosts ?? [])].sort();
      lines.push(
        hosts.length
          ? `- **Networking**: limited — allowed hosts: ${hosts.map((h) => `\`${h}\``).join(", ")}`
          : "- **Networking**: limited — no allowed hosts configured (outbound may fail)",
      );
    } else {
      lines.push("- **Networking**: unrestricted (subject to vault credential injection on matching hosts)");
    }
  }

  if (cfg?.packages) {
    const pkgLines: string[] = [];
    for (const key of ["pip", "npm", "apt", "cargo", "gem", "go"] as const) {
      const list = cfg.packages[key];
      if (list?.length) {
        pkgLines.push(`${key}: ${[...list].sort().join(", ")}`);
      }
    }
    if (pkgLines.length) {
      lines.push(`- **Preinstalled packages**: ${pkgLines.join("; ")}`);
    }
  }

  if (cfg?.resources?.instance_type) {
    lines.push(`- **Instance size**: \`${cfg.resources.instance_type}\``);
  }

  if (cfg?.git_repo?.url) {
    const mount = cfg.git_repo.mount_path || "/workspace";
    const branch = cfg.git_repo.branch ? ` (branch \`${cfg.git_repo.branch}\`)` : "";
    lines.push(
      `- **Auto-cloned repo**: \`${cfg.git_repo.url}\`${branch} → \`${mount}\``,
    );
  }

  if (kind === "local" && cfg?.local) {
    const local = cfg.local;
    lines.push(`- **Local ACP agent**: \`${local.acp_agent_id}\``);
    if (local.working_dir) {
      lines.push(`- **Host working_dir**: \`${local.working_dir}\``);
    }
    if (local.branch) lines.push(`- **Git branch**: \`${local.branch}\``);
    if (local.worktree?.branch) {
      lines.push(`- **Git worktree branch**: \`${local.worktree.branch}\``);
    }
  }

  if (provider === "oma-remote" && cfg?.remote) {
    lines.push(
      `- **Remote federation**: instance \`${cfg.remote.instance_id}\`, agent \`${cfg.remote.agent_id}\`` +
        (cfg.remote.environment_id ? `, env \`${cfg.remote.environment_id}\`` : ""),
    );
  }

  const note = PROVIDER_NOTES[provider.toLowerCase()];
  if (note) {
    lines.push("", `### Provider notes`, note);
  }

  return lines.join("\n");
}

/**
 * Compose agent.system + platform guidance + optional sandbox environment
 * block + optional platform reminders (skills / memory_prompts /
 * appendable_prompts).
 *
 * Reminders are appended to the system prompt instead of broadcast as
 * `<system-reminder>` user.message events. The legacy approach
 * leaked the raw skill bodies into the visible conversation feed and
 * the event log — operators correctly objected that skill content is
 * static-per-session context and belongs in the system prompt where
 * Claude already knows to treat it as such.
 *
 * Each reminder is wrapped in an XML-ish `<source name="…">…</source>`
 * block so the model still has a structural cue about where each chunk
 * came from (matching Anthropic's scratchpad / source convention) and so
 * downstream consumers can grep the prompt for a specific skill.
 *
 * Sandbox env guidance is inlined (not a reminder) so it sits on the
 * same static prefix as platform guidance for a given environment.
 *
 * If the agent has no system prompt of its own AND no reminders, the
 * guidance alone becomes the system prompt.
 */
export function composeSystemPrompt(
  rawSystemPrompt: string | null | undefined,
  reminders?: ReadonlyArray<{ source: string; text: string }>,
  sandboxEnv?: SandboxEnvInfo | null,
): string {
  const raw = rawSystemPrompt ?? "";
  let base = raw ? `${raw}\n\n${platformGuidance}` : platformGuidance;
  const sandboxBlock = buildSandboxEnvironmentGuidance(sandboxEnv);
  if (sandboxBlock) base = `${base}\n\n${sandboxBlock}`;
  if (!reminders?.length) return base;
  const blocks = reminders
    .map((r) => `<source name="${r.source}">\n${r.text}\n</source>`)
    .join("\n\n");
  return `${base}\n\n${blocks}`;
}
