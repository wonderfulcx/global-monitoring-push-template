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
  return out;
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
  const base = readGlobal(context, "gm_self_api_url");
  const tenantLabel = readGlobal(context, "gm_tenant_label");
  const tier = normalizeTier(readGlobal(context, "gm_tier"));
  const apiKey = selfReadToken(context.secrets.get("SERVICE_MONITORING_TOKEN"));

  if (!base || !tenantLabel || !apiKey) {
    logErr("missing_config", { has_base: !!base, has_label: !!tenantLabel, has_token: !!apiKey });
    return {
      error: "missing_config",
      message: "gm_self_api_url, gm_tenant_label, and SERVICE_MONITORING_TOKEN must all be set.",
    };
  }
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

  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = (await fetch(COLLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tenantLabel, payload, api_key: PUSH_TOKEN }),
    })) as unknown as typeof res;
  } catch (e) {
    logErr("push transport error", String(e));
    return { error: "push_transport_error", message: String(e) };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as Record<string, unknown>)?.error) {
    logErr("push rejected", { status: res.status, body });
    throw new Error(`push failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  log("push ok", { status: res.status, windows: ranges, pushed_at: now });
  return { ok: true, tier, pushed_at: now, pushed_windows: ranges, collect_response: body };
}
