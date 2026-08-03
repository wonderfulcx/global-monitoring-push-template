# Global Monitoring — Push Template

Install this plugin on **each monitored tenant**. It creates one enabled
`monitoring_push` cron that reads the tenant locally, applies the configured
sharing tier, and sends a snapshot to the Global Monitoring hub every five
minutes.

## Required configuration

| Setting | Value |
| --- | --- |
| Secret `SERVICE_MONITORING_TOKEN` | A read token for this same tenant |
| Global `gm_self_api_url` | This tenant's API base URL, for example `https://tenant.api.example.wonderful.ai` |
| Global `gm_tenant_label` | The label shown on the hub dashboard |

Optional global `gm_tier` controls disclosure (`T0`–`T3`, default `T3`). For
authenticated tenant identity, set secret `GM_PUSH_KEY` here, mirror it as
`GM_PUSH_KEY_<TENANT_SLUG>` on the hub, and add the tenant label to the hub's
`gm_push_tenants` global.

## Data flow

```text
monitored tenant: monitoring_push (*/5 * * * *)
        -> public collect_tenant_status endpoint on the hub
        -> pushed_tenant_status + pushed_status_history
        -> global_monitoring_status -> Global Monitoring app
```

After installation, verify that `monitoring_push` exists under Resources →
Functions → Cron, is enabled, and that the hub receives a new snapshot within
five minutes. An "installed" Catalog record is not sufficient evidence: if the
cron resource is absent, reinstall this plugin on the monitored tenant.
