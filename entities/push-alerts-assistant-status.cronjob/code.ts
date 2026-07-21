// push_alerts_assistant_status — pub/sub push template, sender side.
//
// Hourly: reads THIS tenant's own status (self-referential read, via its
// own API key — a function has no ambient access to its own tenant's REST
// API, same as any cross-tenant call) and POSTs it to germany-internal's
// collect_tenant_status endpoint.
//
// Deliberately not hardcoded to one tenant: `tenant_label` is a global
// variable, not a constant, so this exact same plugin (same repo, same
// version) can be installed on any number of tenants that want to push
// instead of being pulled — only the config differs per install, never
// the code. First install: fde-onboarding-v2, labeled "Alerts-Assistant"
// as a test tenant standing in for a real one (e.g. Eventim later).
//
// Payload shape mirrors global-monitoring-status's per-tenant object
// (wonderful/global-monitoring repo) so the consuming dashboard doesn't
// need to special-case pushed vs pulled tenants.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_FILTERS = encodeURIComponent("{}");
const EXACT_COUNT_EMPTY_FILTERS = encodeURIComponent(JSON.stringify({ filters: [] }));

function secretApiKey(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  const obj = raw as Record<string, unknown> | null;
  const apiKey = obj?.api_key ?? (obj?.value as Record<string, unknown> | undefined)?.api_key;
  return typeof apiKey === "string" ? apiKey : undefined;
}

async function apiGet(baseUrl: string, path: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
  return res.json();
}

function unwrapList(payload: unknown): { items: Record<string, unknown>[]; total: number } {
  const p = payload as Record<string, unknown> | undefined;
  const d = (p?.data ?? p) as Record<string, unknown> | unknown[] | undefined;
  const items = Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
  const pag = (p?.pagination ?? (d as Record<string, unknown>)?.pagination) as
    | { total?: unknown; total_rows?: unknown }
    | undefined;
  const total = pag?.total_rows ?? pag?.total ?? items.length;
  return { items, total: typeof total === "number" ? total : items.length };
}

async function getList(base: string, apiKey: string, path: string) {
  try {
    return unwrapList(await apiGet(base, path, apiKey));
  } catch (e) {
    return { items: [] as Record<string, unknown>[], total: 0, error: (e as Error).message };
  }
}

async function getExactCommsCount(
  base: string,
  apiKey: string,
  range?: { startDate: number; endDate: number },
) {
  const q = range ? `&startDate=${range.startDate}&endDate=${range.endDate}` : "";
  try {
    const raw = (await apiGet(base, `/api/v2/communications/count?filters=${EXACT_COUNT_EMPTY_FILTERS}${q}`, apiKey)) as Record<
      string,
      unknown
    >;
    const count = (raw?.data as Record<string, unknown> | undefined)?.count ?? raw?.count;
    return { count: typeof count === "number" ? count : 0 };
  } catch (e) {
    return { count: 0, error: (e as Error).message };
  }
}

const OPEN_ISSUE_STATUSES = new Set(["open", "pending", "in-progress"]);
const isOpenIssue = (i: Record<string, unknown>) => OPEN_ISSUE_STATUSES.has(String(i.status ?? "").toLowerCase());
const isOpenAlert = (i: Record<string, unknown>) => String(i.status ?? "").toLowerCase() === "open";

async function userFunction(context: Context): Promise<Result> {
  const base = String(context.globals.get("self_api_url") ?? "");
  const collectUrl = String(context.globals.get("global_monitoring_collect_url") ?? "");
  const tenantLabel = String(context.globals.get("tenant_label") ?? "");
  const apiKey = secretApiKey(context.secrets.get("FDE_SELF_READ_API_KEY"));
  const pushKey = secretApiKey(context.secrets.get("GLOBAL_MONITORING_PUSH_KEY"));
  // Real, platform-issued germany-internal API key (a scoped Service
  // Account: Maintainer org role, Dashboard Editor on General) — required
  // for the request to even reach the function at all (platform gateway
  // auth, same as every other cross-tenant call in this project).
  // GLOBAL_MONITORING_PUSH_KEY alone is a self-generated string the
  // platform doesn't recognize, and 401s at the gateway before our code
  // ever runs if used as the only credential.
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

  const [issues, incidents, commsTotal, issuesWeek, alertsWeek, commsWeekTotal] = await Promise.all([
    getList(base, apiKey, `/api/v1/issues?filters=${EMPTY_FILTERS}&limit=1000`),
    getList(base, apiKey, `/api/v1/alerts/incidents?filters=${EMPTY_FILTERS}&limit=1000`),
    getExactCommsCount(base, apiKey),
    getList(base, apiKey, `/api/v1/issues?filters=${EMPTY_FILTERS}&limit=1&startDate=${weekAgo}&endDate=${now}`),
    getList(base, apiKey, `/api/v1/alerts/incidents?filters=${EMPTY_FILTERS}&limit=1&start_date=${weekAgo}&end_date=${now}`),
    getExactCommsCount(base, apiKey, { startDate: weekAgo, endDate: now }),
  ]);

  const openIssues = issues.items.filter(isOpenIssue).length;
  const activeAlerts = incidents.items.filter(isOpenAlert).length;
  const severity = activeAlerts > 0 ? "critical" : openIssues > 0 ? "attention" : "healthy";

  const payload = {
    name: tenantLabel,
    interactions: commsTotal.count,
    interactions_this_week: commsWeekTotal.count,
    open_issues: openIssues,
    issues_opened_this_week: issuesWeek.total,
    active_alerts: activeAlerts,
    alerts_triggered_this_week: alertsWeek.total,
    severity,
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
