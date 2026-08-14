import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { BrowserVmProvider, useBrowserVm } from "./BrowserVmProvider";

/**
 * Exercises BrowserVmProvider's postMessage handling — the parent half of
 * the `oma-bvm:*` wire protocol shared with the /sandbox-tab child page
 * (owned by another agent; this file only consumes the wire shapes).
 */

function Consumer() {
  const { status, runtimeId, engine, logs, ops, stats, start, runShell, requestStats } =
    useBrowserVm();
  return (
    <div>
      <div data-testid="status">{status}</div>
      <div data-testid="runtimeId">{runtimeId ?? ""}</div>
      <div data-testid="engine">{engine ?? ""}</div>
      <div data-testid="logCount">{logs.length}</div>
      <div data-testid="opCount">{ops.length}</div>
      <div data-testid="stats">{stats ? JSON.stringify(stats) : ""}</div>
      <button onClick={() => void start()}>start</button>
      <button
        onClick={() => {
          void runShell("echo hi")
            .then((out) => {
              document.title = `shell-ok:${out}`;
            })
            .catch((err: Error) => {
              document.title = `shell-err:${err.message}`;
            });
        }}
      >
        run
      </button>
      <button
        onClick={() => {
          void requestStats()
            .then(() => {
              document.title = "stats-ok";
            })
            .catch((err: Error) => {
              document.title = `stats-err:${err.message}`;
            });
        }}
      >
        stats
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <BrowserVmProvider>
      <Consumer />
    </BrowserVmProvider>,
  );
}

function getIframe(): HTMLIFrameElement {
  const iframe = document.querySelector("iframe");
  if (!iframe) throw new Error("iframe not mounted");
  return iframe;
}

function postFromChild(data: unknown, opts?: { origin?: string; source?: Window | null }) {
  const iframe = getIframe();
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: opts?.origin ?? window.location.origin,
      source: opts && "source" in opts ? opts.source : iframe.contentWindow,
    }),
  );
}

async function startAndMount(user: ReturnType<typeof userEvent.setup>) {
  server.use(
    http.post("/v1/runtimes/connect-runtime", async ({ request }) => {
      const body = (await request.json()) as { state?: string };
      expect(body.state).toBeTruthy();
      return HttpResponse.json({ code: "deadbeef", expires_at: 0 });
    }),
  );
  await user.click(screen.getByRole("button", { name: "start" }));
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  // Let the mint request resolve and status settle to "pairing".
  await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("pairing"));
}

describe("<BrowserVmProvider />", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the VM offline when the heartbeat goes stale (child wedged/crashed)", async () => {
    server.use(
      http.post("/v1/runtimes/connect-runtime", async () =>
        HttpResponse.json({ code: "deadbeef", expires_at: 0 }),
      ),
    );
    // Fake timers from the start so the watchdog's setInterval (registered
    // once the iframe mounts) is registered under the fake clock — faking
    // timers only after start() would leave that interval on the real
    // clock, where advanceTimersByTimeAsync can never reach it.
    vi.useFakeTimers();
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    // Flush the mint request's real microtask chain (MSW resolves over
    // real Node I/O, independent of the faked macrotask clock) without
    // advancing virtual time, until the iframe actually mounts — status
    // flips to "pairing" synchronously before the mint request even
    // starts, so that alone isn't a reliable signal the iframe (and the
    // watchdog's setInterval, registered on iframe mount) exists yet.
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull(), {
      timeout: 1000,
      interval: 10,
    });
    postFromChild({ type: "oma-bvm:status", status: "online", runtime_id: "rt_1", engine: "v86" });
    // React 18 batches the state update from the message listener via a
    // microtask flush — give it one tick under the fake clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("status")).toHaveTextContent("online");

    // Past STALE_THRESHOLD_MS (70s) with no further heartbeat — the
    // watchdog's setInterval (every 10s) should flip status to "offline".
    await vi.advanceTimersByTimeAsync(90_000);

    expect(screen.getByTestId("status")).toHaveTextContent("offline");
  });


  it("mints a pairing code and mounts a hidden iframe pointed at /sandbox-tab?embedded=1 on start()", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    const iframe = getIframe();
    const url = new URL(iframe.src);
    expect(url.pathname).toBe("/sandbox-tab");
    expect(url.searchParams.get("code")).toBe("deadbeef");
    expect(url.searchParams.get("embedded")).toBe("1");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("does not mint a second code when start() is called again while pairing", async () => {
    const user = userEvent.setup();
    let mintCalls = 0;
    server.use(
      http.post("/v1/runtimes/connect-runtime", () => {
        mintCalls += 1;
        return HttpResponse.json({ code: "deadbeef", expires_at: 0 });
      }),
    );
    renderProvider();
    await user.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("pairing"));
    await user.click(screen.getByRole("button", { name: "start" }));
    await user.click(screen.getByRole("button", { name: "start" }));
    expect(mintCalls).toBe(1);
  });

  it("applies a status message from the child iframe", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    postFromChild({
      type: "oma-bvm:status",
      status: "online",
      runtime_id: "rt_123",
      engine: "v86",
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("online"));
    expect(screen.getByTestId("runtimeId")).toHaveTextContent("rt_123");
    expect(screen.getByTestId("engine")).toHaveTextContent("v86");
  });

  it("ignores a message from the wrong origin", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    postFromChild(
      { type: "oma-bvm:status", status: "online", runtime_id: "rt_evil", engine: "v86" },
      { origin: "https://evil.example.com" },
    );

    // Status stays "pairing" — the malicious-origin message never applied.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("status")).toHaveTextContent("pairing");
    expect(screen.getByTestId("runtimeId")).toHaveTextContent("");
  });

  it("ignores a message whose source isn't the mounted iframe's window", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    postFromChild(
      { type: "oma-bvm:status", status: "online", runtime_id: "rt_evil", engine: "v86" },
      { source: null },
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("status")).toHaveTextContent("pairing");
    expect(screen.getByTestId("runtimeId")).toHaveTextContent("");
  });

  it("ignores messages whose type doesn't start with oma-bvm:", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    postFromChild({ type: "some-other-message", status: "online" });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("status")).toHaveTextContent("pairing");
  });

  it("appends log lines and caps the rolling buffer at 500", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    for (let i = 0; i < 510; i++) {
      postFromChild({ type: "oma-bvm:log", line: `line ${i}`, ts: i });
    }

    await waitFor(() => expect(screen.getByTestId("logCount")).toHaveTextContent("500"));
  });

  it("tracks recent ops", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    postFromChild({ type: "oma-bvm:op", op: "boot", phase: "start", ts: 1 });
    postFromChild({ type: "oma-bvm:op", op: "boot", phase: "done", ts: 2 });

    await waitFor(() => expect(screen.getByTestId("opCount")).toHaveTextContent("2"));
  });

  it("resolves requestStats() when a stats message arrives", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    await user.click(screen.getByRole("button", { name: "stats" }));
    postFromChild({
      type: "oma-bvm:stats",
      ts: 1,
      cpu_pct: 12.5,
      mem_used_kb: 1024,
      mem_total_kb: 4096,
      uptime_s: 60,
      processes: [{ pid: "1", comm: "init" }],
    });

    await waitFor(() => expect(document.title).toBe("stats-ok"));
    expect(screen.getByTestId("stats")).toHaveTextContent("\"cpu_pct\":12.5");
  });

  it("resolves runShell() by accumulating chunks until done:true", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    const iframe = getIframe();
    const postSpy = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    await user.click(screen.getByRole("button", { name: "run" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [sentMsg] = postSpy.mock.calls[0] as [{ type: string; id: string; command: string }];
    expect(sentMsg.type).toBe("oma-bvm:shell");
    expect(sentMsg.command).toBe("echo hi");
    const { id } = sentMsg;

    postFromChild({ type: "oma-bvm:shell-output", id, chunk: "hi", done: false });
    postFromChild({ type: "oma-bvm:shell-output", id, chunk: "", done: true });

    await waitFor(() => expect(document.title).toBe("shell-ok:hi"));
  });

  it("rejects runShell() when the child reports an error on done", async () => {
    const user = userEvent.setup();
    renderProvider();
    await startAndMount(user);

    const iframe = getIframe();
    const postSpy = vi.spyOn(iframe.contentWindow as Window, "postMessage");

    await user.click(screen.getByRole("button", { name: "run" }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [sentMsg] = postSpy.mock.calls[0] as [{ id: string }];

    postFromChild({
      type: "oma-bvm:shell-output",
      id: sentMsg.id,
      chunk: "",
      done: true,
      error: "command not found",
    });

    await waitFor(() => expect(document.title).toBe("shell-err:command not found"));
  });
});
