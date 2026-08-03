// Connect-machine instructions shown inside the "Add runtime" dialog's
// "Connect local machine" tab. Pure presentational — takes the copy state
// + handler so the parent owns the toast.
import { toast } from "sonner";

import { CopyButton } from "./CopyButton";
import { RECONNECT_CMD, SETUP_CMD } from "../lib/bridge-commands";

const EXAMPLE_AGENTS = [
  {
    name: "claude-acp",
    cmd: "npx -y @agentclientprotocol/claude-agent-acp",
    note: "auto-installed if `claude` is on PATH",
  },
  {
    name: "codex-acp",
    cmd: "download from zed-industries/codex-acp releases",
    note: null,
  },
  {
    name: "openclaw",
    cmd: "npm i -g openclaw",
    note: "uses `openclaw acp` bridge",
  },
  {
    name: "hermes",
    cmd: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    note: null,
  },
];

const AUTO_INSTALL = [
  { binary: "claude", pkg: "@agentclientprotocol/claude-agent-acp" },
  { binary: "codex", pkg: "@normahq/codex-acp-bridge" },
  { binary: "gemini", pkg: "@google/gemini-cli" },
];

export function ConnectMachineInstructions({
  copied,
  onCopy,
}: {
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    onCopy(text, key);
    toast.success("Copied");
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        On the machine you want to connect, run:
      </p>
      <CopyButton id="bridge-setup" text={SETUP_CMD} copied={copied} onCopy={copy} />
      <p className="text-fg-muted text-xs">
        Setup opens this browser for OAuth, writes credentials to{" "}
        <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
        that keeps the daemon running across reboots. The daemon scans your{" "}
        <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">$PATH</code> for
        ACP-compatible agents and reports them in the Connected machines list.
      </p>

      <div>
        <p className="text-fg-muted text-xs mb-1.5">
          <strong>Featured agents</strong> — OMA&rsquo;s recommended set:
        </p>
        <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc">
          {EXAMPLE_AGENTS.map((a) => (
            <li key={a.name}>
              <span className="text-fg">{a.name}</span> —{" "}
              <button
                onClick={() => copy(a.cmd, `agent-${a.name}`)}
                className="inline-flex items-center gap-1 font-mono text-fg-muted hover:text-brand transition-colors"
              >
                {a.cmd}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
              </button>
              {a.note && <span className="text-fg-subtle ml-1">({a.note})</span>}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-fg-muted text-xs mb-1.5">
          Setup auto-installs an ACP wrapper when an upstream binary is on{" "}
          <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">$PATH</code>:
        </p>
        <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc">
          {AUTO_INSTALL.map(({ binary, pkg }) => (
            <li key={binary}>
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">{binary}</code> → installs{" "}
              <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">{pkg}</code>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-fg-muted text-xs">
        30+ other agents (gemini, opencode, cline, cursor, kimi, qwen-code, …) come from the{" "}
        <a
          href="https://agentclientprotocol.com/get-started/registry"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-brand"
        >
          official ACP Registry
        </a>{" "}
        — daemon fetches the manifest at startup and any installed binary becomes selectable.
      </p>

      <div className="rounded-md border border-border bg-bg-surface/50 p-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">If the daemon is already running</div>
        <p className="text-xs text-fg-muted mb-2">
          Restart it to pick up new agents or config changes:
        </p>
        <CopyButton id="bridge-restart" text={RECONNECT_CMD} copied={copied} onCopy={copy} />
      </div>
    </div>
  );
}
