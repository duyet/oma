import { describe, it, expect } from "vitest";
import {
  ANYROUTER_API_BASE,
  ANYROUTER_OAUTH_AUTHORIZE_URL,
  ANYROUTER_OAUTH_REGISTER_URL,
  ANYROUTER_OAUTH_SCOPE,
  ANYROUTER_OAUTH_TOKEN_URL,
  base64url,
  buildAuthorizeUrl,
  buildModelsRequest,
  buildRegisterRequest,
  buildTokenRequest,
  generatePkcePair,
  generateState,
  parseModelsResponse,
  parsePresetsResponse,
  parseRegisterResponse,
  parseTokenResponse,
  toGatewayModelId,
} from "../src/index";

describe("@duyet/oma-anyrouter — pkce", () => {
  it("generatePkcePair returns a 43-char verifier and its S256 challenge", async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(verifier).toHaveLength(43);
    expect(challenge).toHaveLength(43);
    // base64url alphabet only — no +, /, or = padding.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    // Recompute S256(verifier) independently and confirm it matches.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(base64url(new Uint8Array(digest))).toBe(challenge);
  });

  it("generatePkcePair returns fresh values on every call", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("generateState returns an opaque base64url token", () => {
    const s1 = generateState();
    const s2 = generateState();
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s1).not.toBe(s2);
  });
});

describe("@duyet/oma-anyrouter — dynamic client registration", () => {
  it("buildRegisterRequest is a PKCE-only public-client DCR POST", () => {
    const req = buildRegisterRequest({
      clientName: "Open Managed Agents",
      redirectUris: ["https://oma.example.com/v1/providers/anyrouter/callback"],
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(ANYROUTER_OAUTH_REGISTER_URL);
    const body = JSON.parse(req.body);
    expect(body.client_name).toBe("Open Managed Agents");
    expect(body.redirect_uris).toEqual([
      "https://oma.example.com/v1/providers/anyrouter/callback",
    ]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("parseRegisterResponse extracts client_id", () => {
    const client = parseRegisterResponse(
      JSON.stringify({
        client_id: "mcpc_abc123",
        client_name: "Open Managed Agents",
        redirect_uris: ["https://oma.example.com/callback"],
      }),
    );
    expect(client).toEqual({
      clientId: "mcpc_abc123",
      clientName: "Open Managed Agents",
      redirectUris: ["https://oma.example.com/callback"],
    });
  });

  it("parseRegisterResponse throws when client_id is missing", () => {
    expect(() => parseRegisterResponse(JSON.stringify({ error: "rate_limited" }))).toThrow();
  });
});

describe("@duyet/oma-anyrouter — oauth scope", () => {
  it("requests inference plus preset + credit read scopes, space-separated", () => {
    const scopes = ANYROUTER_OAUTH_SCOPE.split(" ");
    expect(scopes).toContain("standard");
    expect(scopes).toContain("read:presets");
    expect(scopes).toContain("read:credits");
  });
});

describe("@duyet/oma-anyrouter — authorize redirect", () => {
  it("buildAuthorizeUrl sets every required PKCE + OAuth param", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "mcpc_abc123",
        redirectUri: "https://oma.example.com/callback",
        state: "state-xyz",
        codeChallenge: "challenge-abc",
        scope: "standard",
      }),
    );
    expect(url.origin + url.pathname).toBe(ANYROUTER_OAUTH_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("mcpc_abc123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://oma.example.com/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toBe("standard");
  });

  it("omits scope when not provided", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "c",
        redirectUri: "https://oma.example.com/callback",
        state: "s",
        codeChallenge: "ch",
      }),
    );
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("@duyet/oma-anyrouter — token exchange", () => {
  it("buildTokenRequest sends the authorization_code grant with the PKCE verifier", () => {
    const req = buildTokenRequest({
      clientId: "mcpc_abc123",
      redirectUri: "https://oma.example.com/callback",
      code: "authcode_1",
      codeVerifier: "verifier-value",
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(ANYROUTER_OAUTH_TOKEN_URL);
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "authcode_1",
      redirect_uri: "https://oma.example.com/callback",
      client_id: "mcpc_abc123",
      code_verifier: "verifier-value",
    });
  });

  it("parseTokenResponse extracts the minted sk-ar-… key", () => {
    const token = parseTokenResponse(
      JSON.stringify({
        access_token: "sk-ar-v1-abcdef",
        token_type: "Bearer",
        scope: "read:llm-keys write:llm-keys inference",
        origin: "mcp:standard:mcpc_abc123",
      }),
    );
    expect(token.accessToken).toBe("sk-ar-v1-abcdef");
    expect(token.tokenType).toBe("Bearer");
    expect(token.origin).toBe("mcp:standard:mcpc_abc123");
  });

  it("parseTokenResponse throws with the upstream error_description on failure", () => {
    expect(() =>
      parseTokenResponse(
        JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }),
      ),
    ).toThrow(/PKCE verification failed/);
  });
});

describe("@duyet/oma-anyrouter — model catalog", () => {
  it("buildModelsRequest sends the key as a bearer token", () => {
    const req = buildModelsRequest("sk-ar-v1-abcdef");
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${ANYROUTER_API_BASE}/models`);
    expect(req.headers.authorization).toBe("Bearer sk-ar-v1-abcdef");
  });

  it("parseModelsResponse accepts a bare array", () => {
    const models = parseModelsResponse(
      JSON.stringify([{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]),
    );
    expect(models).toEqual([
      {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        raw: { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      },
    ]);
  });

  it("parseModelsResponse accepts a { data: [...] } envelope and skips rows without an id", () => {
    const models = parseModelsResponse(
      JSON.stringify({ data: [{ id: "openai/gpt-5" }, { name: "no id here" }] }),
    );
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("openai/gpt-5");
  });

  it("parsePresetsResponse reads the top-level presets array and skips rows without an id", () => {
    const presets = parsePresetsResponse(
      JSON.stringify({
        data: [{ id: "anthropic/claude-sonnet-4-6" }],
        presets: [
          {
            id: "pre_1",
            slug: "fast-coder",
            name: "Fast Coder",
            description: "Speedy edits",
            config: { model: "anthropic/claude-sonnet-4-6" },
          },
          { slug: "no-id" },
        ],
      }),
    );
    expect(presets).toHaveLength(1);
    expect(presets[0]).toEqual({
      id: "pre_1",
      slug: "fast-coder",
      name: "Fast Coder",
      description: "Speedy edits",
      config: { model: "anthropic/claude-sonnet-4-6" },
      raw: {
        id: "pre_1",
        slug: "fast-coder",
        name: "Fast Coder",
        description: "Speedy edits",
        config: { model: "anthropic/claude-sonnet-4-6" },
      },
    });
  });

  it("parsePresetsResponse tolerates a response with no presets field", () => {
    const presets = parsePresetsResponse(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }));
    expect(presets).toEqual([]);
  });
});

describe("@duyet/oma-anyrouter — toGatewayModelId", () => {
  it("prefixes a bare claude-* handle with anthropic/", () => {
    expect(toGatewayModelId("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("does not convert hyphens to dots", () => {
    expect(toGatewayModelId("claude-sonnet-4-6")).not.toContain("claude-sonnet-4.6");
    expect(toGatewayModelId("anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("leaves provider/model ids and non-Claude handles unchanged", () => {
    expect(toGatewayModelId("google/gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(toGatewayModelId("gpt-4o")).toBe("gpt-4o");
  });
});
