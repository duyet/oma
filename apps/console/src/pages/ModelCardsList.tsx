import { useState, useMemo, useCallback, useEffect } from "react";
import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { useConfirm } from "@/hooks/useConfirm";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { TextInput, SecretInput } from "../components/Input";
import { toast } from "sonner";
import type { ModelCard } from "@duyet/oma-api-types";
import { INITIAL_FORM as AGENT_INITIAL_FORM, formToConfig } from "./agents/AgentFormDialog";

// ─── AnyRouter — "Connect to AnyRouter" OAuth (PKCE) button ────────────
//
// Minimal integration: status check + a button that navigates the browser
// into the backend-driven OAuth flow (GET /v1/providers/anyrouter/connect →
// AnyRouter consent → GET .../callback mints an sk-ar-… key and hot-swaps
// the node's active model provider — see apps/main-node/src/index.ts
// buildModel + packages/http-routes/src/providers/anyrouter.ts). A real
// top-level navigation is required (not a fetch) so the browser carries the
// operator's AnyRouter session cookie through the consent screen.
interface AnyRouterStatus {
  connected: boolean;
  connected_at?: string;
  base_url?: string;
  /** Present when this deployment auto-minted a model_cards row for the
   *  connected key (Cloudflare — see packages/http-routes/src/providers/
   *  anyrouter.ts upsertModelCard). Absent on self-host Node, which has no
   *  D1 model-cards store and hot-swaps a process-global provider instead. */
  model_card_id?: string;
  /** The card's current wire-level target, e.g. "anthropic/claude-sonnet-4-6". */
  model?: string;
  /** Every model card bound to this connection (base card + starter siblings
   *  + cards added via "Add model"), all sharing the one stored key. Empty on
   *  deployments without a model-cards store. */
  cards?: AnyRouterBoundCard[];
}

interface AnyRouterBoundCard {
  id: string;
  model_id: string;
  model: string;
  is_default: boolean;
}

interface AnyRouterModelOption {
  id: string;
  name?: string;
}

interface AnyRouterPreset {
  slug: string;
  name?: string;
  description?: string;
}

interface AnyRouterCredits {
  connect_required?: boolean;
  balance?: number;
  today_cost?: number;
  currency?: string;
}

/** Split a wire target like "model@preset/slug" or "@preset/slug" into parts. */
function parseTarget(model: string | undefined): { model: string; preset: string } {
  if (!model) return { model: "", preset: "" };
  const at = model.indexOf("@preset/");
  if (at === -1) return { model, preset: "" };
  return { model: model.slice(0, at), preset: model.slice(at + "@preset/".length) };
}

function composeTarget(model: string, preset: string): string {
  if (!preset) return model;
  return `${model}@preset/${preset}`;
}

function AnyRouterConnectCard({
  onStatus,
  onCardsChanged,
}: {
  onStatus?: (s: AnyRouterStatus) => void;
  /** Fired when this panel created/removed a card, so the table above can
   *  reload — the panel owns AnyRouter-bound cards, the table owns the rest. */
  onCardsChanged?: () => void;
}) {
  const { api } = useApi();
  const [status, setStatus] = useState<AnyRouterStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<AnyRouterModelOption[]>([]);
  const [presets, setPresets] = useState<AnyRouterPreset[]>([]);
  const [credits, setCredits] = useState<AnyRouterCredits | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newCardId, setNewCardId] = useState("");
  const [newCardModel, setNewCardModel] = useState("");

  const refresh = useCallback(() => {
    api<AnyRouterStatus>("/v1/providers/anyrouter/status")
      .then((s) => {
        setStatus(s);
        onStatus?.(s);
      })
      .catch(() => {
        setStatus({ connected: false });
        onStatus?.({ connected: false });
      });
  }, [api, onStatus]);

  useEffect(() => {
    refresh();
    // Surface the redirect back from /v1/providers/anyrouter/callback, then
    // scrub the query string so a page refresh doesn't re-toast.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("anyrouter_connected");
    const error = params.get("anyrouter_error");
    if (connected) toast.success("Connected to AnyRouter — agents on this node now route through it.");
    if (error) toast.error(`AnyRouter connect failed: ${error}`);
    if (connected || error) {
      params.delete("anyrouter_connected");
      params.delete("anyrouter_error");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
  }, [refresh]);

  // Only fetch the catalog once connected AND a card exists to bind the
  // picker to — no point offering choices with nowhere to save them
  // (self-host Node has no model_card_id, see AnyRouterStatus doc above).
  useEffect(() => {
    if (!status?.connected || !status.model_card_id) {
      setModels([]);
      setPresets([]);
      return;
    }
    api<{ data: AnyRouterModelOption[]; presets?: AnyRouterPreset[] }>("/v1/providers/anyrouter/models")
      .then((res) => {
        setModels(res.data ?? []);
        setPresets(res.presets ?? []);
      })
      .catch(() => {
        setModels([]);
        setPresets([]);
      });
  }, [api, status?.connected, status?.model_card_id]);

  // Credits ride their own fetch — the endpoint is cheap (60s server cache)
  // and shouldn't block the model picker if it errors.
  useEffect(() => {
    if (!status?.connected) {
      setCredits(null);
      return;
    }
    api<AnyRouterCredits>("/v1/providers/anyrouter/credits")
      .then((c) => setCredits(c.connect_required ? null : c))
      .catch(() => setCredits(null));
  }, [api, status?.connected]);

  const disconnect = async () => {
    setBusy(true);
    try {
      await api("/v1/providers/anyrouter/disconnect", { method: "POST" });
      toast.success("Disconnected from AnyRouter.");
      refresh();
    } catch (e: any) {
      toast.error(e?.message || "Failed to disconnect from AnyRouter");
    } finally {
      setBusy(false);
    }
  };

  // Retarget any AnyRouter-backed card — the base card or a sibling. Goes
  // through the generic model-cards update route because changing `model`
  // needs no credential (the card keeps the key it was created with).
  const changeCardTarget = async (cardId: string, current: string, target: string) => {
    if (!cardId || !target || target === current) return;
    setModelBusy(true);
    try {
      await api(`/v1/model_cards/${cardId}`, {
        method: "POST",
        body: JSON.stringify({ model: target }),
      });
      toast.success(`Now targeting ${target}.`);
      refresh();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update the target model");
    } finally {
      setModelBusy(false);
    }
  };

  const changeTarget = (model: string, preset: string) => {
    if (!status?.model_card_id) return;
    changeCardTarget(status.model_card_id, status.model ?? "", composeTarget(model, preset));
  };

  // "Add model" — mint another card on the SAME connected key. The key never
  // reaches the browser, so this can't go through POST /v1/model_cards.
  const addCard = async () => {
    const modelId = newCardId.trim();
    const model = newCardModel.trim();
    if (!modelId || !model) return;
    setModelBusy(true);
    try {
      await api("/v1/providers/anyrouter/cards", {
        method: "POST",
        body: JSON.stringify({ model_id: modelId, model }),
      });
      toast.success(`Model card "${modelId}" created on your AnyRouter key.`);
      setNewCardId("");
      setNewCardModel("");
      setAdding(false);
      refresh();
      onCardsChanged?.();
    } catch (e: any) {
      toast.error(e?.message || "Failed to create the model card");
    } finally {
      setModelBusy(false);
    }
  };

  const removeCard = async (card: AnyRouterBoundCard) => {
    setModelBusy(true);
    try {
      await api(`/v1/model_cards/${card.id}`, { method: "DELETE" });
      toast.success(`Removed ${card.model_id}.`);
      refresh();
      onCardsChanged?.();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remove the model card");
    } finally {
      setModelBusy(false);
    }
  };

  const setAsDefault = async () => {
    if (!status?.model_card_id) return;
    setBusy(true);
    try {
      await api(`/v1/model_cards/${status.model_card_id}`, {
        method: "POST",
        body: JSON.stringify({ is_default: true }),
      });
      toast.success("AnyRouter set as the default model for new agents.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to set AnyRouter as default");
    } finally {
      setBusy(false);
    }
  };

  // One-click starter agents. The backend provisions the sibling model cards
  // (anyrouter-strong / anyrouter-fast, sharing the connected key) and returns
  // their handles; we build the actual agents through the same formToConfig
  // machinery the agent form uses, so there's a single source of truth for the
  // agent payload shape. Each spec maps to a card role.
  const createStarterAgents = async () => {
    setBusy(true);
    try {
      const res = await api<{
        cards: { model_id: string; model: string; role: string; label: string }[];
      }>("/v1/providers/anyrouter/presets", { method: "POST" });
      const byRole = Object.fromEntries((res.cards ?? []).map((card) => [card.role, card]));
      const specs = [
        {
          role: "strong",
          name: "AnyRouter Assistant",
          system:
            "You are a helpful, capable general-purpose assistant. Think step by step and give clear, accurate answers.",
        },
        {
          role: "fast",
          name: "AnyRouter Summarizer",
          system:
            "You summarize text concisely and faithfully. Given any input, return a tight, accurate summary that preserves the key points.",
        },
      ];
      let created = 0;
      for (const spec of specs) {
        const card = byRole[spec.role];
        if (!card) continue;
        const config = formToConfig({
          ...AGENT_INITIAL_FORM,
          name: spec.name,
          system: spec.system,
          model: card.model_id,
        });
        try {
          await api("/v1/agents", { method: "POST", body: JSON.stringify(config) });
          created += 1;
        } catch {
          // Most likely a name collision from a prior run — skip this one but
          // keep going so the other starter agent still lands.
        }
      }
      if (created > 0) {
        toast.success(`Created ${created} starter agent${created === 1 ? "" : "s"} wired to AnyRouter.`);
      } else {
        toast.error("Starter agents already exist (or couldn't be created).");
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to create starter agents");
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">AnyRouter</div>
          <div className="text-xs text-fg-subtle">
            {status.connected
              ? "Connected — agents with model \"anyrouter\" route through AnyRouter's gateway (150+ models, unified billing)."
              : "Connect once via OAuth to route agents through AnyRouter, without pasting an sk-ar-… key by hand."}
          </div>
        </div>
        {status.connected ? (
          <Button variant="ghost" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button onClick={() => window.location.assign("/v1/providers/anyrouter/connect")}>
            Connect to AnyRouter
          </Button>
        )}
      </div>
      {status.connected && credits && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-3 text-xs">
          <span className="text-fg-subtle">
            Credits:{" "}
            <span className="font-medium text-fg tabular-nums">
              ${(credits.balance ?? 0).toFixed(2)}
            </span>
          </span>
          <span className="text-fg-subtle">
            Today:{" "}
            <span className="font-medium text-fg tabular-nums">
              ${(credits.today_cost ?? 0).toFixed(2)}
            </span>
          </span>
          <a
            href="https://anyrouter.dev"
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-brand hover:underline"
          >
            Open AnyRouter ↗
          </a>
        </div>
      )}
      {status.connected && status.model_card_id && (() => {
        const target = parseTarget(status.model);
        return (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-fg-subtle">Model:</span>
            <Select
              value={target.model || undefined}
              onValueChange={(m) => changeTarget(m, target.preset)}
              disabled={modelBusy || models.length === 0}
            >
              <SelectTrigger size="sm" className="min-w-56">
                <SelectValue placeholder={target.model || "Loading models…"} />
              </SelectTrigger>
              <SelectContent>
                {(models.some((m) => m.id === target.model)
                  ? models
                  : target.model
                    ? [{ id: target.model, name: target.model }, ...models]
                    : models
                ).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name ? `${m.name} (${m.id})` : m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {presets.length > 0 && (
              <>
                <span className="text-xs text-fg-subtle">Preset:</span>
                <Select
                  value={target.preset || "__none__"}
                  onValueChange={(v) => changeTarget(target.model, v === "__none__" ? "" : v)}
                  disabled={modelBusy}
                >
                  <SelectTrigger size="sm" className="min-w-40">
                    <SelectValue placeholder="No preset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No preset</SelectItem>
                    {presets.map((pr) => (
                      <SelectItem key={pr.slug} value={pr.slug}>
                        {pr.name ? `${pr.name} (@${pr.slug})` : `@${pr.slug}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={setAsDefault} disabled={busy}>
              Set as default
            </Button>
            <Button variant="ghost" size="sm" onClick={createStarterAgents} disabled={busy}>
              Create starter agents
            </Button>
          </div>
        );
      })()}
      {status.connected && status.model_card_id && (
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-fg-subtle">
              Other models on this key — each is a model card agents can name.
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdding((v) => !v)}
              disabled={modelBusy || models.length === 0}
            >
              {adding ? "Cancel" : "+ Add model"}
            </Button>
          </div>
          {adding && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={newCardModel || undefined} onValueChange={setNewCardModel}>
                <SelectTrigger size="sm" className="min-w-56">
                  <SelectValue placeholder="Pick a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name ? `${m.name} (${m.id})` : m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <TextInput
                value={newCardId}
                onChange={(e) => setNewCardId(e.target.value)}
                placeholder="Card handle, e.g. anyrouter-opus"
                aria-label="Model card handle"
                className="w-56 border border-border rounded-md px-3 py-1.5 text-sm bg-bg text-fg outline-none focus:border-brand"
              />
              <Button size="sm" onClick={addCard} disabled={modelBusy || !newCardId.trim() || !newCardModel}>
                Create card
              </Button>
            </div>
          )}
          {(status.cards ?? [])
            .filter((card) => card.id !== status.model_card_id)
            .map((card) => (
              <div key={card.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-fg-muted min-w-40">{card.model_id}</span>
                <Select
                  value={parseTarget(card.model).model || undefined}
                  onValueChange={(m) =>
                    changeCardTarget(card.id, card.model, composeTarget(m, parseTarget(card.model).preset))
                  }
                  disabled={modelBusy || models.length === 0}
                >
                  <SelectTrigger size="sm" className="min-w-56">
                    <SelectValue placeholder={card.model} />
                  </SelectTrigger>
                  <SelectContent>
                    {(models.some((m) => m.id === parseTarget(card.model).model)
                      ? models
                      : [{ id: parseTarget(card.model).model, name: card.model }, ...models]
                    ).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name ? `${m.name} (${m.id})` : m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {presets.length > 0 && (
                  <Select
                    value={parseTarget(card.model).preset || "__none__"}
                    onValueChange={(v) =>
                      changeCardTarget(
                        card.id,
                        card.model,
                        composeTarget(parseTarget(card.model).model, v === "__none__" ? "" : v),
                      )
                    }
                    disabled={modelBusy}
                  >
                    <SelectTrigger size="sm" className="min-w-40">
                      <SelectValue placeholder="No preset" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No preset</SelectItem>
                      {presets.map((pr) => (
                        <SelectItem key={pr.slug} value={pr.slug}>
                          {pr.name ? `${pr.name} (@${pr.slug})` : `@${pr.slug}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCard(card)}
                  disabled={modelBusy}
                  className="text-danger hover:text-danger"
                >
                  Remove
                </Button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// Provider enum — mirrors the whitelist on the server
// (apps/main/src/routes/model-cards.ts GET handler). Anything outside
// these four values is rejected with a 400 there, so the chip's option
// set + the form's tile picker must stay in sync with this list.
const PROVIDERS = [
  { value: "ant", label: "Anthropic", desc: "Claude models" },
  { value: "ant-compatible", label: "Anthropic-compatible", desc: "Proxies speaking Anthropic API" },
  { value: "oai", label: "OpenAI", desc: "GPT models" },
  { value: "oai-compatible", label: "OpenAI-compatible", desc: "xAI Grok, DeepSeek, Groq, Together, Ollama, etc." },
] as const;

// One-click endpoint presets for well-known OpenAI-compatible providers.
// Each fills provider + base_url + a sensible default wire model, so
// "use Grok" is a click + API key instead of hunting for the base URL.
// The user can still edit every field afterwards — this only pre-fills.
const COMPAT_PRESETS: Array<{
  id: string;
  label: string;
  base_url: string;
  model: string;
}> = [
  { id: "xai", label: "xAI Grok", base_url: "https://api.x.ai/v1", model: "grok-4" },
  { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "together", label: "Together", base_url: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
];

type ProviderValue = (typeof PROVIDERS)[number]["value"];

const PROVIDER_FILTER_OPTIONS: { value: ProviderValue | "any"; label: string }[] = [
  { value: "any", label: "All" },
  ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
];

const OFFICIAL_PROVIDERS = new Set(["ant", "oai"]);

const INITIAL_FORM = {
  provider: "ant" as ProviderValue,
  model_id: "",
  model: "",
  api_key: "",
  base_url: "",
  is_default: false,
  custom_headers: [{ key: "", value: "" }] as Array<{ key: string; value: string }>,
};

export function ModelCardsList() {
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [error, setError] = useState("");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showModelSuggestions, setShowModelSuggestions] = useState(false);
  // The card row auto-minted by the AnyRouter connect flow — managed from
  // the AnyRouter panel above the table, so it's excluded from the table
  // itself (editing/deleting it by hand would fight the managed connection).
  const [anyrouterCardIds, setAnyrouterCardIds] = useState<string[]>([]);
  // api_key_preview of the card being edited — shown under the key field so
  // "type to replace" is explicit.
  const [editingPreview, setEditingPreview] = useState<string | null>(null);
  const confirm = useConfirm();

  // Server-driven filter state. Each piece flows into cardsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [provider, setProvider] = useState<ProviderValue | "any">("any");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const cardsParams = useMemo(
    () => ({
      ...(provider !== "any" ? { provider } : {}),
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [provider, created.after, created.before, search],
  );

  const {
    items: cards,
    isLoading: loading,
    error: fetchError,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<ModelCard>("/v1/model_cards", { limit: 20, params: cardsParams });

  // Fetch models from official API using the user's key
  const fetchModels = useCallback(async (provider: string, apiKey: string) => {
    if (!OFFICIAL_PROVIDERS.has(provider) || !apiKey || apiKey.length < 8) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    try {
      const result = await api<{ data: Array<{ id: string; name: string }> }>("/v1/models/list", {
        method: "POST",
        body: JSON.stringify({ provider, api_key: apiKey }),
      });
      setAvailableModels(result.data);
    } catch {
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, [api]);

  const save = async () => {
    setError("");
    if (!form.model_id || (!editingId && !form.api_key)) {
      setError("Model ID and API Key are required.");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        provider: form.provider,
        model_id: form.model_id,
        // model defaults to model_id when blank — common case is "the handle
        // IS the LLM string". Users only fill `model` when they want a
        // distinct wire-level value (e.g. handle "claude-prod" → wire
        // "claude-sonnet-4-6").
        model: form.model || form.model_id,
        api_key: form.api_key,
        is_default: form.is_default,
      };
      if (form.base_url) payload.base_url = form.base_url;
      // Serialize custom headers from array to object
      const hdrs: Record<string, string> = {};
      for (const h of form.custom_headers) {
        if (h.key && h.value) hdrs[h.key] = h.value;
      }
      if (Object.keys(hdrs).length > 0) payload.custom_headers = hdrs;
      if (editingId) {
        if (!form.api_key) delete payload.api_key;
        await api(`/v1/model_cards/${editingId}`, { method: "POST", body: JSON.stringify(payload) });
      } else {
        // Create returns the card + a probe result. Surface it so the user
        // finds out NOW if their api_key / base_url / model id is broken.
        const created = await api<{ probe?: { ok: boolean | null; message?: string; reason?: string } }>(
          "/v1/model_cards",
          { method: "POST", body: JSON.stringify(payload) },
        );
        const probe = created.probe;
        if (probe?.ok === true) {
          toast.success(`Model card created — ${form.provider} key verified.`);
        } else if (probe?.ok === false) {
          toast.warning(
            probe.message
              ? `Model card saved but the key didn't work: ${probe.message}`
              : "Model card saved but the key didn't work — check api_key / base_url / model id.",
          );
        }
        // ok === null (unsupported provider) → no toast, success is implicit.
      }
      closeDialog(); load();
    } catch (e: any) { setError(e?.message || "Failed to save"); }
  };

  const remove = async (id: string) => {
    try { await api(`/v1/model_cards/${id}`, { method: "DELETE" }); load(); } catch {}
  };

  const startEdit = (card: ModelCard) => {
    const hdrs = card.custom_headers
      ? Object.entries(card.custom_headers).map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }];
    if (hdrs.length === 0) hdrs.push({ key: "", value: "" });
    setForm({
      // Older rows on disk may carry a provider value outside the current
      // enum (e.g. legacy "anthropic"); the tile picker simply leaves none
      // selected in that case. Cast keeps the form state strictly typed.
      provider: card.provider as ProviderValue,
      model_id: card.model_id,
      model: card.model,
      api_key: "",
      base_url: card.base_url || "",
      is_default: card.is_default || false,
      custom_headers: hdrs,
    });
    setEditingId(card.id); setEditingPreview(card.api_key_preview ?? null); setShowCreate(true); setError("");
  };

  const closeDialog = () => {
    setShowCreate(false); setEditingId(null); setEditingPreview(null); setForm({ ...INITIAL_FORM }); setError("");
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  const providerLabel = (p: string) => PROVIDERS.find((x) => x.value === p)?.label || p;

  const providerBadge = (p: string) => {
    if (p === "ant" || p === "ant-compatible") return "bg-warning-subtle text-warning";
    if (p === "oai" || p === "oai-compatible") return "bg-success-subtle text-success";
    return "bg-bg-surface text-fg-muted";
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. The id+model_id
  // pair opts out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying. Actions also stays
  // visible — without Edit/Delete the table is read-only and there's
  // no detail page to drill into.
  const columns = useMemo<ColumnDef<ModelCard>[]>(
    () => [
      {
        id: "model_id",
        accessorKey: "model_id",
        header: "Model ID",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">{row.original.model_id}</div>
            <div className="text-xs text-fg-subtle font-mono">{row.original.id}</div>
          </>
        ),
        enableHiding: false,
      },
      {
        id: "provider",
        accessorKey: "provider",
        header: "API Format",
        cell: ({ row }) => (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${providerBadge(row.original.provider)}`}>
            {providerLabel(row.original.provider)}
          </span>
        ),
      },
      {
        id: "model",
        accessorKey: "model",
        header: "Wire Model",
        cell: ({ row }) =>
          row.original.model === row.original.model_id ? (
            <span className="text-fg-subtle">(same)</span>
          ) : (
            <span className="font-mono text-xs text-fg-muted">{row.original.model}</span>
          ),
      },
      {
        id: "api_key",
        accessorFn: (c) => c.api_key_preview ?? "",
        header: "API Key",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-subtle">
            ****{row.original.api_key_preview}
          </span>
        ),
      },
      {
        id: "base_url",
        accessorFn: (c) => c.base_url ?? "",
        header: "Base URL",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">{row.original.base_url || "—"}</span>
        ),
      },
      {
        id: "default",
        accessorFn: (c) => (c.is_default ? "default" : ""),
        header: "Default",
        cell: ({ row }) =>
          row.original.is_default ? (
            <span className="text-xs text-fg-muted bg-bg-surface px-1.5 py-0.5 rounded">
              default
            </span>
          ) : null,
      },
      {
        id: "created",
        accessorFn: (c) => c.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
    ],
    // Intentionally empty: startEdit + remove close over `form`/`api`
    // but the column defs only need to reflect identity, not capture a
    // fresh closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Provider ▾" rather than "Provider: All ▾". The
  // clear-X only renders when the chip is in non-default state.
  const providerDisplay =
    provider === "any"
      ? undefined
      : PROVIDER_FILTER_OPTIONS.find((o) => o.value === provider)?.label;

  const filters = (
    <>
      <FilterChip
        label="Provider"
        active={provider !== "any"}
        display={providerDisplay}
        onClear={() => setProvider("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-56 p-0"
        >
          <FacetedFilter
            options={PROVIDER_FILTER_OPTIONS}
            value={provider}
            onValueChange={(v) => setProvider(v as ProviderValue | "any")}
            searchPlaceholder="Provider..."
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  // Stable identity — an inline arrow would re-trigger the card's
  // status-fetch effect on every parent render.
  const handleAnyRouterStatus = useCallback((s: AnyRouterStatus) => {
    const ids = (s.cards ?? []).map((c) => c.id);
    if (s.model_card_id && !ids.includes(s.model_card_id)) ids.push(s.model_card_id);
    setAnyrouterCardIds(ids);
  }, []);

  // AnyRouter's managed cards live in the panel below, not the table.
  const tableCards = cards.filter(
    (c) => !anyrouterCardIds.includes(c.id) && c.model_id !== "anyrouter",
  );

  return (
    <div className="py-6 space-y-8">
      <DataTable<ModelCard>
      subtitle="A model card binds a model handle to a provider, API key, and base URL, so an agent can name it instead of the default provider."
      createLabel="+ New model card"
      onCreate={() => { setShowCreate(true); setError(""); }}
      searchPlaceholder="Search model cards..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={tableCards}
      loading={loading}
      error={fetchError}
      onRetry={load}
      errorTitle="Couldn't load model cards"
      onRowClick={(c) => startEdit(c)}
      getRowId={(c) => c.id}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? "No matching model cards" : "No model cards yet"}
      emptyKind="model_card"
      emptyAction={
        !search && (
          <Button onClick={() => { setShowCreate(true); setError(""); }}>
            + New model card
          </Button>
        )
      }
      emptySubtitle={
        search ? (
          "Try a different search term."
        ) : (
          <>
            <p>
              A model card stores the API credentials and model your agents should use. Add
              one to configure API credentials for your agents.
            </p>
            <p className="text-xs mt-3">
              Without model cards, agents use the environment ANTHROPIC_API_KEY.
            </p>
          </>
        )
      }
      columns={columns}
    >
      <Modal open={showCreate} onClose={closeDialog} title={editingId ? "Edit Model Card" : "New Model Card"}
        footer={
          <>
            {editingId && (
              <Button
                variant="ghost"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Delete model card ${form.model_id}?`,
                      description: "This can't be undone.",
                      confirmLabel: "Delete",
                      destructive: true,
                    }))
                  )
                    return;
                  await remove(editingId);
                  closeDialog();
                }}
                className="text-danger hover:text-danger hover:bg-danger-subtle mr-auto"
              >
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={closeDialog}>Cancel</Button>
            <Button onClick={save} disabled={!form.model_id || (!editingId && !form.api_key)}>{editingId ? "Save" : "Create"}</Button>
          </>
        }>
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-3">
          {error && <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label htmlFor="modelcard-id" className="text-sm text-fg-muted block mb-1">
              Model ID *
              <span className="ml-1 text-xs text-fg-subtle">(tenant-unique handle agents reference)</span>
            </label>
            <TextInput id="modelcard-id" value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} className={inputCls}
              placeholder="claude-prod, claude-sonnet-4-6, bedrock-sonnet, ..." />
          </div>
          <div role="group" aria-labelledby="modelcard-provider-label">
            <span id="modelcard-provider-label" className="text-sm text-fg-muted block mb-1">API Format *</span>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={form.provider === p.value}
                  onClick={() => { setForm({ ...form, provider: p.value, model: "", base_url: "" }); setAvailableModels([]); }}
                  className={`text-left px-3 py-2 border rounded-md text-sm transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                    form.provider === p.value
                      ? "border-brand bg-brand-subtle text-fg"
                      : "border-border text-fg-muted hover:border-fg-subtle"
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-fg-subtle mt-0.5">{p.desc}</div>
                </button>
              ))}
            </div>
            {/* Known OpenAI-compatible endpoints — a preset fills format +
                base URL + default wire model in one click; the fields stay
                editable. Model ID is only filled when still empty so a
                user-chosen handle is never clobbered. */}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-xs text-fg-subtle">Quick start:</span>
              {COMPAT_PRESETS.map((p) => {
                const active = form.provider === "oai-compatible" && form.base_url === p.base_url;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setForm({
                        ...form,
                        provider: "oai-compatible",
                        base_url: p.base_url,
                        model: p.model,
                        model_id: form.model_id || p.model,
                      });
                      setAvailableModels([]);
                    }}
                    className={`px-2 py-0.5 rounded-full border text-xs transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                      active
                        ? "border-brand bg-brand-subtle text-fg"
                        : "border-border text-fg-muted hover:border-fg-subtle"
                    }`}
                    title={`${p.base_url} · ${p.model}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor="modelcard-api-key" className="text-sm text-fg-muted block mb-1">API Key {editingId ? "" : "*"}</label>
            <SecretInput id="modelcard-api-key" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} className={inputCls}
              placeholder={editingId ? "Type a new key to replace the current one" : "sk-..."}
              name="model-api-key-field"
              onBlur={() => { if (OFFICIAL_PROVIDERS.has(form.provider) && form.api_key) fetchModels(form.provider, form.api_key); }} />
            {editingId && editingPreview && !form.api_key && (
              <p className="text-xs text-fg-subtle mt-1">
                Current key: <span className="font-mono">****{editingPreview}</span> — kept unless you enter a new one.
              </p>
            )}
            {OFFICIAL_PROVIDERS.has(form.provider) && modelsLoading && (
              <p className="text-xs text-fg-subtle mt-1">Loading models...</p>
            )}
          </div>
          <div className="relative">
            <label htmlFor="modelcard-wire-model" className="text-sm text-fg-muted block mb-1">
              Wire Model
              <span className="ml-1 text-xs text-fg-subtle">(sent to provider; defaults to Model ID)</span>
            </label>
            <input id="modelcard-wire-model" value={form.model}
              onChange={(e) => { setForm({ ...form, model: e.target.value }); setShowModelSuggestions(true); }}
              onFocus={() => setShowModelSuggestions(true)}
              onBlur={() => setTimeout(() => setShowModelSuggestions(false), 150)}
              className={inputCls}
              placeholder={form.model_id || (OFFICIAL_PROVIDERS.has(form.provider)
                ? (form.provider === "ant" ? "claude-sonnet-4-6" : "gpt-4o")
                : "e.g. deepseek-chat, llama-3.1-70b, ...")}
              autoComplete="off" name="model-field" />
            {showModelSuggestions && availableModels.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-bg border border-border rounded-md shadow-lg py-1 max-h-48 overflow-y-auto">
                {availableModels
                  .filter((m) => !form.model || m.id.includes(form.model) || m.name.toLowerCase().includes(form.model.toLowerCase()))
                  .map((m) => (
                    <button key={m.id} type="button"
                      onMouseDown={() => { setForm({ ...form, model: m.id }); setShowModelSuggestions(false); }}
                      className="w-full text-left px-3 py-1.5 min-h-11 sm:min-h-0 text-sm hover:bg-bg-surface">
                      <span className="text-fg">{m.name !== m.id ? m.name : m.id}</span>
                      {m.name !== m.id && <span className="text-fg-subtle text-xs ml-2">{m.id}</span>}
                    </button>
                  ))}
              </div>
            )}
            {OFFICIAL_PROVIDERS.has(form.provider) && !availableModels.length && !modelsLoading && form.api_key && (
              <p className="text-xs text-fg-subtle mt-1">Enter a valid API key to load available models</p>
            )}
          </div>
          {!OFFICIAL_PROVIDERS.has(form.provider) && (
            <div>
              <label htmlFor="modelcard-base-url" className="text-sm text-fg-muted block mb-1">Base URL *</label>
              <input id="modelcard-base-url" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className={inputCls}
                placeholder={form.provider === "ant-compatible" ? "https://your-proxy.com/v1" : "https://api.deepseek.com/v1"} autoComplete="off" />
            </div>
          )}
          {!OFFICIAL_PROVIDERS.has(form.provider) && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">Custom Headers <span className="text-fg-subtle">(optional)</span></label>
              <div className="space-y-1.5">
                {form.custom_headers.map((h, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input value={h.key} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], key: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} className={inputCls} placeholder="Header-Name" aria-label={`Custom header ${i + 1} name`} autoComplete="off" />
                    <input value={h.value} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], value: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} className={inputCls} placeholder="value" aria-label={`Custom header ${i + 1} value`} autoComplete="off" />
                    {form.custom_headers.length > 1 && (
                      <button type="button" onClick={() => setForm({ ...form, custom_headers: form.custom_headers.filter((_, j) => j !== i) })}
                        className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger text-xs shrink-0">Remove</button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => setForm({ ...form, custom_headers: [...form.custom_headers, { key: "", value: "" }] })}
                  className="inline-flex items-center justify-center min-h-11 sm:min-h-0 px-2 text-xs text-fg-muted hover:text-fg">+ Add header</button>
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer">
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="rounded accent-brand" />
            Set as default model card
          </label>
        </form>
      </Modal>
      </DataTable>

      {/* Provider connections — its own bordered block below the table so
          AnyRouter reads as a distinct managed-connection panel, not a row
          of the model-cards table. The onStatus callback still feeds
          `anyrouterCardId`, which filters the managed card out of the table
          above. */}
      <section className="border border-border rounded-lg bg-bg-surface/30 p-4 sm:p-5">
        <h2 className="font-display text-lg font-semibold text-fg mb-1">Provider connections</h2>
        <p className="text-[13px] text-fg-muted mb-3">
          Managed connections — one click, keys minted for you.
        </p>
        <AnyRouterConnectCard onStatus={handleAnyRouterStatus} onCardsChanged={load} />
      </section>
    </div>
  );
}
