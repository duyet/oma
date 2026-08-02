/**
 * LocalCredentialProxy — the bridge daemon's outbound credential injector.
 *
 * Issue #318. The `subprocess` bridge-relay sandbox runs an agent's tools on
 * the user's own machine, so — unlike every cloud sandbox — there was no
 * outbound MITM proxy in front of it and `cap_cli` / `static_bearer` vault
 * credentials were never injected. An agent asking for `gh`/git auth silently
 * used whatever the machine itself held.
 *
 * This is the local analog of the cloud path (apps/agent/src/oma-sandbox.ts
 * `inject_vault_creds` → `env.MAIN_MCP.lookupOutboundCredential`) and of the
 * self-host one (apps/oma-vault). Same matching logic, same header, resolved
 * by the SAME platform code — the daemon never re-implements the match:
 *
 *   relayed subprocess ──HTTP_PROXY / git insteadOf──▶ this proxy (127.0.0.1)
 *        │                                                 │
 *        │                                    resolve(host) │  over the existing
 *        │                                                 ▼  sandbox relay WS
 *        │                                        agent DO → MAIN_MCP
 *        │                                    .lookupOutboundCredential()
 *        ▼
 *   upstream sees `Authorization: Bearer …`, the subprocess never does.
 *
 * SECURITY PROPERTIES (the reason this file exists):
 *   - The resolved token is held in THIS process's memory only, in a cache
 *     with a short TTL. It is never written to disk, never placed in the
 *     relayed subprocess's environment, never written into a git config, and
 *     never logged (logs carry the host, never the value).
 *   - The subprocess is only ever handed a `127.0.0.1:<port>` URL, which is
 *     not a secret.
 *   - Hosts with no matching credential are proxied through untouched.
 *   - The listener is loopback-only on an ephemeral port, so nothing off-box
 *     can reach it. It does NOT authenticate its callers, though: any process
 *     running as this user that finds the port can have a request injected.
 *     That is not a new exposure on the personal machine this path targets —
 *     such a process can already use the machine's own `gh`/git credentials,
 *     which is the very gap this proxy exists to close — but it does mean the
 *     proxy grants no isolation between local processes. Do not treat it as a
 *     boundary against other software on the same machine.
 *
 * BOUNDARY — what is NOT injected (deliberate; see docs/runtimes.md):
 *   - Direct `https://` connections. Injecting those needs TLS interception
 *     with a locally generated CA the user must trust machine-wide. We do not
 *     generate or install a CA, so `curl https://…`, `gh`, and any other tool
 *     that opens its own TLS session reach upstream un-injected exactly as
 *     they do today.
 *   - `git` over HTTPS IS injected, because git is re-pointed at this proxy
 *     via a per-session `url.<proxy>.insteadOf` rewrite (no secret in that
 *     config) and the proxy re-originates the TLS leg itself.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/** Path prefix for the reverse-proxy form used by the git `insteadOf` rewrite. */
const REVERSE_PREFIX = "/__oma_outbound/";

/** How long a resolved (or absent) credential stays cached in memory. */
const CREDENTIAL_TTL_MS = 60_000;

/** Cap on the git-host probe done once per session, so a silent platform
 *  delays the first command by seconds, not by N lookup timeouts. */
const GIT_PROBE_TIMEOUT_MS = 5_000;

/** Hosts we probe for a credential when building a session's git config. */
export const GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

/** Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Resolves a vault credential for a host, via the platform. Implemented by
 * the relay-backed forwarder in bridge-sandbox.ts; a fake in tests.
 *
 * Returns the bearer token to inject, or null when no credential matches.
 * MUST throw (not return null) on a resolution *failure* so the proxy can
 * tell "no credential" apart from "couldn't ask" in its logging.
 */
export type CredentialResolver = (host: string) => Promise<string | null>;

export interface CredentialProxyOptions {
  resolve: CredentialResolver;
  /** Structured-ish logging sink. Never receives a token. */
  log?: (msg: string) => void;
}

interface CacheEntry {
  token: string | null;
  at: number;
}

export class LocalCredentialProxy {
  #server: Server;
  #resolve: CredentialResolver;
  #log: (msg: string) => void;
  /** host → resolved token (or null for "no credential"), in memory only. */
  #cache = new Map<string, CacheEntry>();
  #port = 0;

  constructor(opts: CredentialProxyOptions) {
    this.#resolve = opts.resolve;
    this.#log = opts.log ?? (() => {});
    this.#server = createServer((req, res) => {
      void this.#onRequest(req, res);
    });
    // A tool that sets HTTPS_PROXY would land here. We never MITM, and a blind
    // tunnel would only add a hop, so refuse loudly instead of pretending.
    this.#server.on("connect", (_req, socket) => {
      socket.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
    });
  }

  /** Bind on an ephemeral loopback port. Returns the proxy base URL. */
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    return this.baseUrl;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async stop(): Promise<void> {
    this.#cache.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /**
   * Environment additions for a relayed subprocess. Contains a loopback URL
   * and nothing else — deliberately no credential material of any kind.
   */
  envVars(): Record<string, string> {
    return {
      HTTP_PROXY: this.baseUrl,
      http_proxy: this.baseUrl,
    };
  }

  /** Cached credential lookup. Returns null when nothing matches. */
  async credentialFor(host: string): Promise<string | null> {
    const hit = this.#cache.get(host);
    if (hit && Date.now() - hit.at < CREDENTIAL_TTL_MS) return hit.token;
    const token = await this.#resolve(host);
    this.#cache.set(host, { token, at: Date.now() });
    return token;
  }

  /** True when the platform has a credential for `host`. */
  async hasCredential(host: string): Promise<boolean> {
    try {
      return (await this.credentialFor(host)) !== null;
    } catch (err) {
      this.#log(`credential lookup for ${host} failed: ${errText(err)}`);
      return false;
    }
  }

  /** The reverse-proxy URL prefix git is rewritten onto for `host`. */
  reverseBase(scheme: string, host: string): string {
    return `${this.baseUrl}${REVERSE_PREFIX}${scheme}/${host}/`;
  }

  // ── request handling ─────────────────────────────────────────────────────

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = parseTarget(req.url ?? "");
    if (!target) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("oma bridge credential proxy: unsupported request form\n");
      return;
    }

    let token: string | null = null;
    try {
      token = await this.credentialFor(target.hostname);
    } catch (err) {
      // Fail OPEN: the request still goes out, just un-injected — the same
      // outcome as before this proxy existed. Failing closed would turn a
      // transient platform blip into a broken agent turn, and the un-injected
      // path is not a new exposure. Loud in the log so it is diagnosable.
      this.#log(
        `WARNING: could not resolve a vault credential for ${target.hostname} ` +
          `(${errText(err)}) — forwarding WITHOUT injection`,
      );
    }

    const outHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
      if (k.toLowerCase() === "host") continue;
      outHeaders[k] = v;
    }
    outHeaders.host = target.host;
    if (token) outHeaders.authorization = `Bearer ${token}`;

    const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = doRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: target.path,
        headers: outHeaders,
      },
      (upRes) => {
        const headers = { ...upRes.headers };
        for (const h of HOP_BY_HOP) delete headers[h];
        // A redirect issued against the reverse form must stay on the proxy,
        // otherwise git follows it straight to upstream and loses injection.
        if (target.reverse && typeof headers.location === "string") {
          headers.location = this.#rewriteLocation(headers.location);
        }
        res.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      this.#log(`upstream ${target.hostname} failed: ${errText(err)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`oma bridge credential proxy: upstream error: ${errText(err)}\n`);
    });
    req.pipe(upstream);
  }

  #rewriteLocation(location: string): string {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      return location; // relative — already stays on the proxy
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return location;
    const scheme = url.protocol.replace(":", "");
    return `${this.reverseBase(scheme, url.host)}${url.pathname.replace(/^\//, "")}${url.search}`;
  }
}

interface Target {
  protocol: "http:" | "https:";
  host: string;
  hostname: string;
  port: string;
  /** origin-form path + query sent upstream. */
  path: string;
  /** True when the request arrived via the reverse (`insteadOf`) form. */
  reverse: boolean;
}

/**
 * Two accepted request forms:
 *   1. forward-proxy absolute-form — `GET http://host/path` (what HTTP_PROXY
 *      makes curl/node/python emit for plain-http requests).
 *   2. reverse form — `GET /__oma_outbound/https/github.com/owner/repo/…`,
 *      which is what git emits after the per-session `insteadOf` rewrite.
 *      This is how an https upstream gets injected without any TLS MITM: git
 *      speaks plaintext to loopback, we originate the TLS leg.
 */
export function parseTarget(rawUrl: string): Target | null {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    return {
      protocol: url.protocol === "https:" ? "https:" : "http:",
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      reverse: false,
    };
  }

  if (rawUrl.startsWith(REVERSE_PREFIX)) {
    const rest = rawUrl.slice(REVERSE_PREFIX.length);
    const firstSlash = rest.indexOf("/");
    if (firstSlash <= 0) return null;
    const scheme = rest.slice(0, firstSlash);
    if (scheme !== "http" && scheme !== "https") return null;
    const afterScheme = rest.slice(firstSlash + 1);
    const secondSlash = afterScheme.indexOf("/");
    const hostPart = secondSlash === -1 ? afterScheme : afterScheme.slice(0, secondSlash);
    const tail = secondSlash === -1 ? "" : afterScheme.slice(secondSlash);
    if (!hostPart) return null;
    let url: URL;
    try {
      url = new URL(`${scheme}://${hostPart}${tail || "/"}`);
    } catch {
      return null;
    }
    return {
      protocol: scheme === "https" ? "https:" : "http:",
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      reverse: true,
    };
  }

  return null;
}

/**
 * Build the per-session git config that routes git's HTTPS traffic through the
 * proxy for hosts that actually have a vault credential.
 *
 * Returns null when no host matched — in that case we leave git completely
 * alone so the machine's own credential helper keeps working exactly as it
 * does today. Rewriting unconditionally would BREAK unauthenticated/local-auth
 * clones for users with no vault credential, which would be a regression.
 *
 * The file contains no secret: only loopback URLs, plus an `include` of the
 * user's real ~/.gitconfig so setting GIT_CONFIG_GLOBAL doesn't blow away
 * their identity, aliases, or helpers.
 */
export function buildGitConfig(
  proxy: Pick<LocalCredentialProxy, "reverseBase">,
  matchedHosts: string[],
): string | null {
  if (matchedHosts.length === 0) return null;
  const lines = [
    "# Generated by `oma bridge daemon` for one relayed sandbox session.",
    "# Routes git's HTTPS traffic through the daemon's local credential proxy",
    "# so vault credentials are injected upstream. Contains no secrets.",
    "[include]",
    `\tpath = ${join(homedir(), ".gitconfig")}`,
  ];
  for (const host of matchedHosts) {
    lines.push(`[url "${proxy.reverseBase("https", host)}"]`);
    lines.push(`\tinsteadOf = https://${host}/`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write the session's git config (when any host matched) and return the env
 * additions that activate it. Empty object when nothing matched.
 */
export async function prepareGitConfig(
  proxy: LocalCredentialProxy,
  workdir: string,
  hosts: string[] = GIT_HOSTS,
): Promise<Record<string, string>> {
  // Probed in parallel, under one shared deadline: a session must not pay one
  // lookup timeout per host before its first command can run.
  const probes = hosts.map(async (host) => ((await proxy.hasCredential(host)) ? host : null));
  const results = await Promise.race([
    Promise.all(probes),
    new Promise<null[]>((resolve) => setTimeout(() => resolve(hosts.map(() => null)), GIT_PROBE_TIMEOUT_MS)),
  ]);
  const matched = results.filter((h): h is string => h !== null);
  const contents = buildGitConfig(proxy, matched);
  if (!contents) return {};
  const path = join(workdir, ".oma-gitconfig");
  await fs.writeFile(path, contents, "utf8");
  return { GIT_CONFIG_GLOBAL: path };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
