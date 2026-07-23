// monitoring_push — pub/sub push template, sender side.
//
// Scheduled cron: self-reads THIS tenant's own status (via its own
// SERVICE_MONITORING_TOKEN) and POSTs a tier-projected snapshot to the PUBLIC
// global-monitoring collect endpoint. No shared secrets.
//
// Cadence = this cron's own schedule. Edit the cronjob's cron_expression to
// change it (e.g. "*/5 * * * *" every 5 min, "0 * * * *" hourly). There is no
// runtime interval gating — the schedule is the single source of truth.
//
// Shared read-logic (apiCall, getList, secretApiKey, fetchTenantStatus,
// computeWindow, …) is inlined from the shared_lib submodule at the marker.
// Edit it in global-monitoring-core, not here.

// @@inline-core

// PUBLIC collect endpoint of the aggregator/hub. It MUST use the public-invoke
// path /api/public/functions/<tenantId>/<workspaceId>/<slug>; the /api/v1/
// functions path requires a gateway Bearer token and 401s for an
// unauthenticated push. <tenantId>/<workspaceId> below identify the hub tenant.
const COLLECT_URL =
  "https://germany-internal.api.demo.wonderful.ai/api/public/functions/3fb838cf-18d6-4a4a-b48c-a2b0c050df28/00000000-0000-0000-0000-000000000000/collect-tenant-status";
// Public namespace marker the collector checks to reject random noise. NOT a
// secret — shipped in the (public) plugin; must equal the collector's
// GLOBAL_MONITORING_PUSH_KEY.
const PUSH_TOKEN = "global-monitoring-public-collect-v1";

// Log to the function run log (guarded so a missing console never breaks a push).
function log(msg: string, extra?: unknown): void {
  try {
    console.log(`[monitoring_push] ${msg}` + (extra !== undefined ? " " + JSON.stringify(extra) : ""));
  } catch {
    /* no-op */
  }
}
function logErr(msg: string, extra?: unknown): void {
  try {
    console.error(`[monitoring_push] ${msg}` + (extra !== undefined ? " " + JSON.stringify(extra) : ""));
  } catch {
    /* no-op */
  }
}

// Data-boundary tier: how much of the full snapshot may leave this tenant.
// Additive; enforced HERE, on the source, before anything is sent.
type Tier = "T0" | "T1" | "T2" | "T3";
const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
function normalizeTier(raw: unknown): Tier {
  const t = String(raw ?? "").trim().toUpperCase();
  return t === "T0" || t === "T1" || t === "T2" ? (t as Tier) : "T3";
}
function applyTier(w: Record<string, unknown>, tier: Tier): Record<string, unknown> {
  const rank = TIER_RANK[tier];
  const out: Record<string, unknown> = { name: w.name, severity: w.severity }; // T0: floor/meta
  if (rank >= 1) {
    out.interactions = w.interactions;
    out.open_issues = w.open_issues;
    out.active_alerts = w.active_alerts;
    out.issues_opened = w.issues_opened;
    out.alerts_triggered = w.alerts_triggered;
  }
  if (rank >= 2) {
    out.agents = w.agents ?? [];
    out.business_metrics = w.business_metrics ?? [];
    out.monitors_by_severity = w.monitors_by_severity;
    out.monitors_by_agent = w.monitors_by_agent ?? [];
  }
  if (rank >= 3) {
    out.alerts = w.alerts ?? [];
    out.monitors = w.monitors ?? [];
  }
  if (Array.isArray(w.errors)) out.errors = w.errors;
  else if (typeof w.error === "string") out.errors = [w.error];
  return out;
}

// Normalize the self-read base URL. Users copy it out of the browser URL bar,
// which is the DASHBOARD host (…​.app.…) — but the API lives on …​.api.… So:
// (1) tolerate a missing scheme, (2) keep only the origin — drops any pasted
// path/query, (3) strip a trailing slash (`…​.ai/` would make calls `…​//api/v1`
// → 404), (4) rewrite the .app host to .api. Cheap, idempotent, and it means
// "just paste whatever's in your address bar" works. A correct .api URL passes
// through unchanged.
function normalizeBase(raw: string): string {
  let b = String(raw ?? "").trim();
  if (!b) return "";
  if (!/^https?:\/\//i.test(b)) b = "https://" + b;
  const origin = b.match(/^(https?:\/\/[^/]+)/i);
  if (origin) b = origin[1];
  b = b.replace(/\/+$/, ""); // strip trailing slash(es) — the // → 404 bug
  return b.replace(/\.app\./i, ".api.");
}

// Self-read credential. SERVICE_MONITORING_TOKEN is a Bearer Token secret
// ({ token }); older installs may hold an API Key ({ api_key }). Sent as
// `Authorization: Bearer <value>` by apiCall.
function selfReadToken(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  const obj = raw as Record<string, unknown> | null;
  const token = obj?.token ?? (obj?.value as Record<string, unknown> | undefined)?.token;
  if (typeof token === "string") return token;
  return secretApiKey(raw);
}

// context.globals.get() THROWS "not-found" for a missing global (confirmed
// live) — it does not return null. So read defensively: missing/unset -> "".
// This is what lets gm_tier be genuinely optional (default in code).
function readGlobal(context: Context, name: string): string {
  try {
    const v = context.globals.get(name);
    return v == null ? "" : String(v);
  } catch {
    return "";
  }
}

async function userFunction(context: Context): Promise<Result> {
  const rawBase = readGlobal(context, "gm_self_api_url");
  const base = normalizeBase(rawBase);
  const tenantLabel = readGlobal(context, "gm_tenant_label");
  const tier = normalizeTier(readGlobal(context, "gm_tier"));
  const apiKey = selfReadToken(context.secrets.get("SERVICE_MONITORING_TOKEN"));

  if (!base || !tenantLabel || !apiKey) {
    logErr("missing_config", { has_base: !!base, has_label: !!tenantLabel, has_token: !!apiKey });
    // Throw (don't return a soft error) so the run is reported as failed, not
    // a green success with an error buried in the output.
    throw new Error(
      "missing_config: gm_self_api_url, gm_tenant_label, and SERVICE_MONITORING_TOKEN must all be set.",
    );
  }
  if (base !== rawBase.trim()) log("normalized self-read base url", { from: rawBase, to: base });
  log("start", { tenant: tenantLabel, tier, base });

  const now = Date.now();
  const ranges: RangeKey[] = ["week", "last7", "last30", "all"];
  // Resilient: one failing window must not sink the whole push. fetchTenantStatus
  // already returns an { error } object rather than throwing; the catch is a
  // defensive, logged backstop.
  const windowResults = await Promise.all(
    ranges.map((r) =>
      Promise.resolve(fetchTenantStatus(tenantLabel, base, apiKey, computeWindow(r, now))).catch((e) => {
        logErr(`window ${r} read failed`, String(e));
        return { name: tenantLabel, error: `window_read_failed: ${String(e)}`, severity: "attention" };
      }),
    ),
  );
  const windows: Record<string, unknown> = {};
  ranges.forEach((r, i) => {
    windows[r] = applyTier(windowResults[i] as Record<string, unknown>, tier);
  });

  // Sender-side timestamp (epoch ms, UTC — no timezone ambiguity) so the receiver
  // can consistency-check against its own received_at.
  const payload = { name: tenantLabel, tier, pushed_at: now, windows };

  // Per-window summary of exactly what is being sent (post-tier), so a user can
  // verify the pushed data in the function's run logs / output on the source tenant.
  const summary = ranges.map((r) => {
    const w = (windows[r] ?? {}) as Record<string, unknown>;
    return {
      window: r,
      interactions: (w.interactions as number) ?? null,
      open_issues: (w.open_issues as number) ?? null,
      active_alerts: (w.active_alerts as number) ?? null,
      business_metrics: Array.isArray(w.business_metrics) ? w.business_metrics.length : 0,
      agents: Array.isArray(w.agents) ? w.agents.length : 0,
      errors: Array.isArray(w.errors) ? (w.errors as string[]).length : 0,
    };
  });
  // The distinct error MESSAGES, deduped across windows (the same read failure
  // repeats in every window). Surfaced in the logs AND the return value so you
  // can read exactly WHAT failed straight from the function's Output/Logs on the
  // source tenant — not just a count. e.g. "business_metrics: HTTP 403: …".
  const errors = [
    ...new Set(
      ranges.flatMap((r) => {
        const w = (windows[r] ?? {}) as Record<string, unknown>;
        return Array.isArray(w.errors) ? (w.errors as string[]) : [];
      }),
    ),
  ];
  log("pushing", { tenant: tenantLabel, tier, pushed_at: now, summary, errors });

  // Did the self-read actually return data? fetchTenantStatus returns an
  // { errors }/{ error } object instead of throwing, so all four windows can
  // "succeed" while carrying nothing but errors. Counting failed windows lets us
  // report the run honestly: a total self-read failure must NOT show as success
  // just because the downstream POST worked (Alex's feedback).
  const failedWindows = windowResults.filter((w) => {
    const o = (w ?? {}) as Record<string, unknown>;
    return (Array.isArray(o.errors) && o.errors.length > 0) || typeof o.error === "string";
  }).length;
  const selfReadFailed = failedWindows === ranges.length;

  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = (await fetch(COLLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tenantLabel, payload, api_key: PUSH_TOKEN }),
    })) as unknown as typeof res;
  } catch (e) {
    logErr("push transport error", String(e));
    throw new Error(`push_transport_error: ${String(e)}`);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as Record<string, unknown>)?.error) {
    logErr("push rejected", { status: res.status, body });
    throw new Error(`push failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  // The POST succeeded — but if the self-read gathered no real data, fail the
  // execution (still pushed the error snapshot above so the tenant's trouble is
  // visible on the dashboard). This is what turns a red-underneath run from a
  // green "success" into an honest failure.
  // Errors are NEVER swallowed. We still pushed whatever we could read (so the
  // dashboard shows partial data), but if ANY read failed the run FAILS — a
  // green "success" must mean "read and reported everything", not merely "the
  // POST returned 200". The exact messages go into the thrown error so they are
  // visible right in the run's Status/Details on the source tenant, not only on
  // the hub dashboard.
  if (errors.length > 0) {
    const kind = selfReadFailed ? "failed (no data read)" : "incomplete (partial data pushed)";
    const hint = selfReadFailed
      ? "Verify gm_self_api_url resolves to the .api host and SERVICE_MONITORING_TOKEN is a valid read key."
      : "The token is likely missing a permission for the failed read(s) — e.g. metrics:view for /api/v2/query/aggregate & /metric-stats.";
    logErr(`self-read ${kind} — failing the run`, { failed_windows: failedWindows, errors });
    throw new Error(`self-read ${kind}: ${errors.join(" | ")} — ${hint}`);
  }

  log("push ok", { status: res.status, pushed_at: now, summary });
  return {
    ok: true,
    tier,
    pushed_at: now,
    pushed_windows: ranges,
    summary,
    self_read_errors: 0,
    errors: [], // green success ⇒ zero read errors (any error would have thrown above)
    collect_response: body,
  };
}
