// push_alerts_assistant_status — pub/sub push template, sender side.
//
// Hourly cron: self-reads THIS tenant's own status (via its own
// SERVICE_MONITORING_TOKEN) and POSTs a snapshot to the public global-monitoring
// collect_tenant_status endpoint.
//
// v0.7.0 — tenant-configurable WHAT + CADENCE, still no shared secrets:
//   • monitoring_tier (T0..T3, default T3) — how much detail leaves this tenant.
//     applyTier() projects each window to that tier BEFORE anything is sent, so
//     enforcement is local. Additive ladder: T0 floor/meta, T1 +health,
//     T2 +per-agent KPIs/business/monitor-rollups, T3 +full alert/monitor lists.
//   • monitoring_push_interval_minutes (default 60) — minimum gap between pushes.
//     The cron fires hourly; a push is skipped if the last one was more recent
//     than the interval. Last-push time persists in the monitoring_push_state
//     table (kv is session-scoped and would NOT survive between cron runs).
// Self-serve install is unchanged: the only required inputs are the tenant's own
// SERVICE_MONITORING_TOKEN + self_api_url + tenant_label; tier/interval are
// optional and default in code.
//
// Shared read-logic (apiCall, getList, secretApiKey, fetchTenantStatus,
// computeWindow, …) is inlined from the shared_lib submodule at the marker.
// Edit it in global-monitoring-core, not here.

// @@inline-core

// The aggregator/hub collect endpoint. Public (is_public) — no auth header.
const COLLECT_URL =
  "https://germany-internal.api.demo.wonderful.ai/api/v1/functions/collect-tenant-status";
// Public namespace marker the collector checks to reject random noise. NOT a
// secret — shipped in the (public) plugin; must equal the collector's
// GLOBAL_MONITORING_PUSH_KEY. Rotate here and on the hub together.
const PUSH_TOKEN = "global-monitoring-public-collect-v1";
const STATE_TABLE = "monitoring_push_state";
const STATE_ID = "state";

// Data-boundary tier: how much of the full snapshot may leave this tenant.
// Additive — each level strictly contains the ones below. Enforced HERE, on the
// source, before anything is sent.
type Tier = "T0" | "T1" | "T2" | "T3";
const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
function normalizeTier(raw: unknown): Tier {
  const t = String(raw ?? "").trim().toUpperCase();
  return t === "T0" || t === "T1" || t === "T2" ? (t as Tier) : "T3";
}
// Project one window's tenant object (fetchTenantStatus shape) down to `tier`.
function applyTier(w: Record<string, unknown>, tier: Tier): Record<string, unknown> {
  const rank = TIER_RANK[tier];
  const out: Record<string, unknown> = { name: w.name, severity: w.severity }; // T0: floor/meta
  if (rank >= 1) {
    // T1 — tenant health rollup
    out.interactions = w.interactions;
    out.open_issues = w.open_issues;
    out.active_alerts = w.active_alerts;
    out.issues_opened = w.issues_opened;
    out.alerts_triggered = w.alerts_triggered;
  }
  if (rank >= 2) {
    // T2 — aggregated: per-agent KPIs, business metrics, monitor rollups
    out.agents = w.agents ?? [];
    out.business_metrics = w.business_metrics ?? [];
    out.monitors_by_severity = w.monitors_by_severity;
    out.monitors_by_agent = w.monitors_by_agent ?? [];
  }
  if (rank >= 3) {
    // T3 — deep: full alert + monitor lists
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

async function userFunction(context: Context): Promise<Result> {
  const base = String(context.globals.get("self_api_url") ?? "");
  const tenantLabel = String(context.globals.get("tenant_label") ?? "");
  const apiKey = selfReadToken(context.secrets.get("SERVICE_MONITORING_TOKEN"));

  if (!base || !tenantLabel || !apiKey) {
    return {
      error: "missing_config",
      message: "self_api_url, tenant_label, and SERVICE_MONITORING_TOKEN must all be set.",
    };
  }

  const tier = normalizeTier(context.globals.get("monitoring_tier"));
  const intervalMin = Math.max(0, Number(context.globals.get("monitoring_push_interval_minutes")) || 60);
  const now = Date.now();

  // Cadence gate: skip if the last push is more recent than the interval.
  // Fail-open — any state-read error just proceeds with the push.
  const stateRow = await context.tables.getRow(STATE_TABLE, STATE_ID).catch(() => null);
  const lastPushedAt = stateRow ? Number((stateRow.data as Record<string, unknown>)?.last_pushed_at ?? 0) : 0;
  if (lastPushedAt && now - lastPushedAt < intervalMin * 60_000) {
    return {
      ok: true,
      skipped: true,
      reason: `interval ${intervalMin}m not elapsed`,
      next_push_in_ms: intervalMin * 60_000 - (now - lastPushedAt),
    };
  }

  const ranges: RangeKey[] = ["week", "last7", "last30", "all"];
  const windowResults = await Promise.all(
    ranges.map((r) => fetchTenantStatus(tenantLabel, base, apiKey, computeWindow(r, now))),
  );
  const windows: Record<string, unknown> = {};
  ranges.forEach((r, i) => {
    windows[r] = applyTier(windowResults[i] as Record<string, unknown>, tier);
  });

  const payload = { name: tenantLabel, tier, windows };

  // Public endpoint: no gateway header. Push token travels in the body and is
  // validated by the collector against its GLOBAL_MONITORING_PUSH_KEY.
  const res = await fetch(COLLECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: tenantLabel, payload, api_key: PUSH_TOKEN }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    throw new Error(`push failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  // Record the push time for the cadence gate (fail-open on write errors).
  try {
    if (stateRow) await context.tables.update(STATE_TABLE, STATE_ID, { last_pushed_at: now });
    else await context.tables.insert(STATE_TABLE, { id: STATE_ID, last_pushed_at: now });
  } catch {
    // non-fatal: next run just re-evaluates against the stale/absent row
  }

  return { ok: true, tier, pushed_windows: ranges, collect_response: body };
}
