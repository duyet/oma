import type { SandboxProviderConfig, SandboxExecutor } from "@getoma/sandbox-sdk";

export interface McpSandboxContext {
  registry: {
    list(): SandboxProviderConfig[];
    get(id: string): SandboxProviderConfig | undefined;
    createExecutor(
      providerId: string,
      ctx: { sessionId: string; workdir: string },
      env: Record<string, string | undefined>,
    ): Promise<SandboxExecutor>;
  };
}

export interface ActiveSandbox {
  id: string;
  providerId: string;
  executor: SandboxExecutor;
  createdAt: string;
}

export interface SandboxHandle {
  id: string;
  provider_id: string;
  created_at: string;
}
