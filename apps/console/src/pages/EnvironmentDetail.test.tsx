import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import {
  EnvironmentDetail,
  applyPackagePreset,
  isValidMetadataKey,
  packagesToRows,
  rowsToPackages,
  type PackageRow,
} from "./EnvironmentDetail";
import { PACKAGE_PRESETS, getProviderGuidance } from "../lib/environmentPresets";

// =================================================================
// Pure helper tests — packages editor serialization
// =================================================================

describe("packages editor serialization", () => {
  it("splits a space-separated packages string into an array per manager", () => {
    const rows: PackageRow[] = [{ manager: "pip", packages: "pandas numpy==2.0" }];
    expect(rowsToPackages(rows)).toEqual({ pip: ["pandas", "numpy==2.0"] });
  });

  it("collapses repeated whitespace and trims when splitting", () => {
    const rows: PackageRow[] = [{ manager: "npm", packages: "  lodash   express  " }];
    expect(rowsToPackages(rows)).toEqual({ npm: ["lodash", "express"] });
  });

  it("drops rows whose packages string is empty/whitespace-only", () => {
    const rows: PackageRow[] = [{ manager: "apt", packages: "   " }];
    expect(rowsToPackages(rows)).toEqual({});
  });

  it("merges multiple rows for the same manager", () => {
    const rows: PackageRow[] = [
      { manager: "pip", packages: "pandas" },
      { manager: "pip", packages: "numpy==2.0" },
    ];
    expect(rowsToPackages(rows)).toEqual({ pip: ["pandas", "numpy==2.0"] });
  });

  it("preserves legacy gem packages verbatim even though there's no gem row", () => {
    const rows: PackageRow[] = [{ manager: "pip", packages: "pandas" }];
    expect(rowsToPackages(rows, ["rails", "rake==13.0"])).toEqual({
      pip: ["pandas"],
      gem: ["rails", "rake==13.0"],
    });
  });

  it("round-trips packagesToRows -> rowsToPackages for a config object", () => {
    const packages = { pip: ["pandas", "numpy"], apt: ["ffmpeg"] };
    const rows = packagesToRows(packages);
    expect(rowsToPackages(rows)).toEqual(packages);
  });

  it("packagesToRows joins each manager's array with spaces", () => {
    const rows = packagesToRows({ cargo: ["ripgrep", "bat==0.24"] });
    expect(rows).toEqual([{ manager: "cargo", packages: "ripgrep bat==0.24" }]);
  });
});

// =================================================================
// Pure helper tests — package preset merging
// =================================================================

describe("applyPackagePreset", () => {
  const dataScience = PACKAGE_PRESETS.find((p) => p.id === "data-science")!;
  const rustCli = PACKAGE_PRESETS.find((p) => p.id === "rust-cli")!;

  it("adds a new row per manager the preset touches when none exists", () => {
    expect(applyPackagePreset([], dataScience)).toEqual([
      { manager: "pip", packages: "numpy pandas matplotlib scikit-learn" },
    ]);
  });

  it("adds a row for each manager a multi-manager preset touches", () => {
    const rows = applyPackagePreset([], rustCli);
    expect(rows).toEqual(
      expect.arrayContaining([
        { manager: "cargo", packages: "ripgrep fd-find bat" },
        { manager: "apt", packages: "jq" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("appends into an existing row for the same manager instead of duplicating it", () => {
    const rows: PackageRow[] = [{ manager: "pip", packages: "requests" }];
    expect(applyPackagePreset(rows, dataScience)).toEqual([
      { manager: "pip", packages: "requests numpy pandas matplotlib scikit-learn" },
    ]);
  });

  it("dedupes packages already present in the row", () => {
    const rows: PackageRow[] = [{ manager: "pip", packages: "numpy" }];
    expect(applyPackagePreset(rows, dataScience)).toEqual([
      { manager: "pip", packages: "numpy pandas matplotlib scikit-learn" },
    ]);
  });

  it("leaves unrelated rows untouched", () => {
    const rows: PackageRow[] = [{ manager: "npm", packages: "lodash" }];
    expect(applyPackagePreset(rows, dataScience)).toEqual([
      { manager: "npm", packages: "lodash" },
      { manager: "pip", packages: "numpy pandas matplotlib scikit-learn" },
    ]);
  });
});

// =================================================================
// Pure helper tests — provider guidance lookup
// =================================================================

describe("getProviderGuidance", () => {
  it("resolves a known provider id", () => {
    expect(getProviderGuidance("boxrun")?.requiredSecret).toBe("BOXRUN_URL");
  });

  it("resolves the 'local' alias to 'subprocess' guidance", () => {
    expect(getProviderGuidance("local")).toEqual(getProviderGuidance("subprocess"));
  });

  it("documents loopback vault injection and the remaining own-TLS gap for subprocess", () => {
    const limitations = getProviderGuidance("subprocess")?.limitations ?? [];
    expect(limitations.join("\n")).toMatch(/git HTTPS/);
    expect(limitations.join("\n")).toMatch(/does not install a CA/);
    expect(limitations.join("\n")).not.toMatch(/outbound HTTP is un-injected/);
  });

  it("defaults to 'cloud' guidance when no provider id is given", () => {
    expect(getProviderGuidance(undefined)?.cf.status).toBe("default");
  });

  it("returns undefined (fail-soft) for an unrecognized provider id", () => {
    expect(getProviderGuidance("some-custom-byok-provider")).toBeUndefined();
  });
});

// =================================================================
// Pure helper tests — metadata lowercase-key validation
// =================================================================

describe("isValidMetadataKey", () => {
  it("accepts an all-lowercase key", () => {
    expect(isValidMetadataKey("team")).toBe(true);
  });

  it("rejects a key containing uppercase letters", () => {
    expect(isValidMetadataKey("Team")).toBe(false);
    expect(isValidMetadataKey("TEAM")).toBe(false);
    expect(isValidMetadataKey("teaM")).toBe(false);
  });

  it("accepts an empty key (handled separately as a no-op row)", () => {
    expect(isValidMetadataKey("")).toBe(true);
  });

  it("accepts lowercase keys with digits/underscores/dashes", () => {
    expect(isValidMetadataKey("owner_1-b")).toBe(true);
  });
});

// =================================================================
// Component-level tests (Testing Library + MSW)
// =================================================================

const baseEnv = {
  id: "env_1",
  name: "My Environment",
  description: "",
  config: {
    type: "cloud",
    packages: {},
    networking: { type: "unrestricted" as const },
  },
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/environments/env_1"]}>
        <Routes>
          <Route path="/environments/:id" element={<EnvironmentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<EnvironmentDetail /> metadata validation", () => {
  it("shows an inline error and disables Save when a metadata key has uppercase letters", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/v1/environments/env_1", () => HttpResponse.json(baseEnv)),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    );
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue("My Environment")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add metadata row" }));
    const keyInput = screen.getByLabelText("Metadata key");
    await user.type(keyInput, "Team");

    expect(await screen.findByText("Keys must be lowercase.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("allows saving once the metadata key is corrected to lowercase", async () => {
    const user = userEvent.setup();
    let putBody: unknown;
    server.use(
      http.get("/v1/environments/env_1", () => HttpResponse.json(baseEnv)),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
      http.put("/v1/environments/env_1", async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json(baseEnv);
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue("My Environment")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add metadata row" }));
    await user.type(screen.getByLabelText("Metadata key"), "team");
    await user.type(screen.getByLabelText("Metadata value"), "platform");

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect((putBody as { metadata?: Record<string, unknown> }).metadata).toEqual({
        team: "platform",
      }),
    );
  });
});

describe("<EnvironmentDetail /> package presets", () => {
  it("clicking a preset button populates the packages editor and saves it on the wire", async () => {
    const user = userEvent.setup();
    let putBody: unknown;
    server.use(
      http.get("/v1/environments/env_1", () => HttpResponse.json(baseEnv)),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
      http.put("/v1/environments/env_1", async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json(baseEnv);
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue("My Environment")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "+ Data science" }));
    expect(screen.getByDisplayValue("numpy pandas matplotlib scikit-learn")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const config = (putBody as { config?: { packages?: Record<string, string[]> } }).config;
      expect(config?.packages?.pip).toEqual(["numpy", "pandas", "matplotlib", "scikit-learn"]);
    });
  });
});

describe("<EnvironmentDetail /> provider guidance panel", () => {
  it("shows required-secret and availability guidance for a known provider", async () => {
    server.use(
      http.get("/v1/environments/env_1", () =>
        HttpResponse.json({
          ...baseEnv,
          config: { ...baseEnv.config, type: "boxrun" },
        }),
      ),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    );
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue("My Environment")).toBeInTheDocument());

    expect(screen.getByText("Sandbox provider guidance")).toBeInTheDocument();
    expect(screen.getByText("BOXRUN_URL")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare deployment")).toBeInTheDocument();
    expect(screen.getByText("Self-host Node")).toBeInTheDocument();
  });

  it("fails soft with a generic message for an unrecognized provider id", async () => {
    server.use(
      http.get("/v1/environments/env_1", () =>
        HttpResponse.json({
          ...baseEnv,
          config: { ...baseEnv.config, type: "some-custom-byok-provider" },
        }),
      ),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    );
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue("My Environment")).toBeInTheDocument());

    expect(screen.getByText(/No specific guidance for/)).toBeInTheDocument();
  });
});

describe("<EnvironmentDetail /> packages editor", () => {
  it("saves a space-separated packages row as an array on the wire", async () => {
    const user = userEvent.setup();
    let putBody: unknown;
    server.use(
      http.get("/v1/environments/env_1", () => HttpResponse.json(baseEnv)),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
      http.put("/v1/environments/env_1", async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json(baseEnv);
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue("My Environment")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add package row" }));
    const packagesInput = screen.getByPlaceholderText("package package==1.0.0");
    await user.type(packagesInput, "pandas numpy==2.0");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const config = (putBody as { config?: { packages?: Record<string, string[]> } }).config;
      expect(config?.packages?.pip).toEqual(["pandas", "numpy==2.0"]);
    });
  });
});
