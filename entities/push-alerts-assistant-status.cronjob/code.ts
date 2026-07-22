// push_alerts_assistant_status — pub/sub push template, sender side.
//
// Hourly: reads THIS tenant's own status (self-referential read via its own
// SERVICE_MONITORING_TOKEN) and POSTs a snapshot to the global-monitoring
// collect_tenant_status endpoint.
//
// v0.6.0 — self-serve: no shared secrets to configure. The collect endpoint is
// PUBLIC (no gateway/invoke key), and the push token below is a public
// namespace marker (a spam gate, not a credential — its only power is "POST a
// status blob"), so it is hardcoded rather than asked of every tenant. The one
// secret a tenant provides is its own SERVICE_MONITORING_TOKEN; the only
// per-tenant globals are self_api_url and tenant_label.
//
// Shared low-level read-logic (apiCall, getList, getExactCommsCount,
// secretApiKey, the open-issue/alert filters) is inlined from the shared_lib
// submodule at the marker below — one source of truth with the hub. Edit it in
// global-monitoring-core, not here.

// @@inline-core

// The aggregator/hub collect endpoint. Public (is_public) — no auth header.
const COLLECT_URL =
  "https://germany-internal.api.demo.wonderful.ai/api/v1/functions/collect-tenant-status";
// Public namespace marker the collector checks to reject random noise. NOT a
// secret — it is intentionally shipped in the (public) plugin and must equal
// the collector's GLOBAL_MONITORING_PUSH_KEY. Rotate by changing it here and on
// the hub together.
const PUSH_TOKEN = "global-monitoring-public-collect-v1";

// Self-read credential. SERVICE_MONITORING_TOKEN is a Bearer Token secret
// ({ token }); older installs may hold an API Key ({ api_key }). Read the token
// first, then fall back to the shared api_key unwrapper. Sent as
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

  const now = Date.now();
  const ranges: RangeKey[] = ["week", "last7", "last30", "all"];
  const windowResults = await Promise.all(
    ranges.map((r) => fetchTenantStatus(tenantLabel, base, apiKey, computeWindow(r, now))),
  );
  const windows: Record<string, unknown> = {};
  ranges.forEach((r, i) => {
    windows[r] = windowResults[i];
  });

  const payload = { name: tenantLabel, windows };

  // Public endpoint: no x-api-key/gateway header. The push token travels in the
  // body and is validated by the collector against its GLOBAL_MONITORING_PUSH_KEY.
  const res = await fetch(COLLECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: tenantLabel, payload, api_key: PUSH_TOKEN }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    throw new Error(`push failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  return { ok: true, pushed_windows: ranges, collect_response: body };
}
