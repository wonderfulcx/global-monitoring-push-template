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
// Payload is currently a thin snapshot (interactions/issues/alerts + a rolling
// "this week"). To make pushed tenants as rich + windowed as pulled ones, this
// is a small change: call the shared `fetchTenantStatus` per preset window and
// push the map (Pattern A) — deferred pending that decision.
//
// Not hardcoded to one tenant: tenant_label / self_api_url / collect URL are
// global variables, so this same plugin installs on any pushing tenant with
// config only.

// @@inline-core

const WEEK_MS = 7 * DAY_MS;

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

  const now = Date.now();
  const weekAgo = now - WEEK_MS;

  const [issues, incidents, commsTotal, issuesWeek, alertsWeek, commsWeek] = await Promise.all([
    getList(base, apiKey, `/api/v1/issues?filters=${EMPTY_FILTERS}&limit=1000`),
    getList(base, apiKey, `/api/v1/alerts/incidents?filters=${EMPTY_FILTERS}&limit=1000`),
    getExactCommsCount(base, apiKey),
    getList(base, apiKey, `/api/v1/issues?filters=${EMPTY_FILTERS}&limit=1&startDate=${weekAgo}&endDate=${now}`),
    getList(base, apiKey, `/api/v1/alerts/incidents?filters=${EMPTY_FILTERS}&limit=1&start_date=${weekAgo}&end_date=${now}`),
    getExactCommsCount(base, apiKey, { startDate: weekAgo, endDate: now }),
  ]);

  const openIssues = issues.items.filter(isOpenIssue).length;
  const activeAlerts = incidents.items.filter(isOpenAlert).length;

  const payload = {
    name: tenantLabel,
    interactions: commsTotal.count,
    interactions_this_week: commsWeek.count,
    open_issues: openIssues,
    issues_opened_this_week: issuesWeek.total,
    active_alerts: activeAlerts,
    alerts_triggered_this_week: alertsWeek.total,
    severity: classifySeverity(activeAlerts, openIssues),
  };

  const res = await fetch(collectUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": invokeKey },
    body: JSON.stringify({ id: tenantLabel, payload, api_key: pushKey }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    throw new Error(`push failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  return { ok: true, pushed: payload, collect_response: body };
}
