// push_alerts_assistant_status — pub/sub push template, sender side.
//
// Hourly: reads THIS tenant's own status (self-referential read via its own
// API key) and POSTs a snapshot to germany-internal's collect_tenant_status.
//
// Shared low-level read-logic (apiCall, getList, getExactCommsCount,
// secretApiKey, the open-issue/alert filters) is inlined from the shared_lib
// submodule at the marker below — one source of truth with the hub, no copied
// helpers. Edit it in global-monitoring-core, not here.
//
// Pattern A: push the RICH, windowed payload so pushed tenants are as
// complete as pulled ones. For each preset window it runs the shared
// `fetchTenantStatus` (same code path the hub uses) and pushes a map keyed
// by range. The consumer picks windows[selectedRange] — no live re-query of
// this tenant, and no feature loss vs. pull.
//
// Not hardcoded to one tenant: tenant_label / self_api_url / collect URL are
// global variables, so this same plugin installs on any pushing tenant with
// config only.

// @@inline-core

async function userFunction(context: Context): Promise<Result> {
  const base = String(context.globals.get("self_api_url") ?? "");
  const collectUrl = String(context.globals.get("global_monitoring_collect_url") ?? "");
  const tenantLabel = String(context.globals.get("tenant_label") ?? "");
  const apiKey = secretApiKey(context.secrets.get("FDE_SELF_READ_API_KEY"));
  const pushKey = secretApiKey(context.secrets.get("GLOBAL_MONITORING_PUSH_KEY"));
  // Real platform-issued germany-internal key — required for the request to
  // reach the collect function at all (gateway auth). GLOBAL_MONITORING_PUSH_KEY
  // is a shared app-level secret validated inside the function (defense in depth).
  const invokeKey = secretApiKey(context.secrets.get("GERMANY_INTERNAL_INVOKE_API_KEY"));

  if (!base || !collectUrl || !tenantLabel || !apiKey || !pushKey || !invokeKey) {
    return {
      error: "missing_config",
      message:
        "self_api_url, global_monitoring_collect_url, tenant_label, FDE_SELF_READ_API_KEY, GLOBAL_MONITORING_PUSH_KEY, GERMANY_INTERNAL_INVOKE_API_KEY must all be set.",
    };
  }

  // One snapshot per preset window. NOTE: fetchTenantStatus re-reads the
  // non-windowed parts (monitors, current open issues/alerts) once per
  // window — correct but redundant; a later optimization can fetch those
  // once and only re-run the windowed counts. Fine at hourly cadence.
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

  const res = await fetch(collectUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": invokeKey },
    body: JSON.stringify({ id: tenantLabel, payload, api_key: pushKey }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    throw new Error(`push failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  return { ok: true, pushed_windows: ranges, collect_response: body };
}
