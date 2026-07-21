# Global Monitoring — Push Template

A pub/sub template for the Global Monitoring dashboard: instead of the
dashboard pulling a tenant's data with a read-only key, this tenant pushes
its own status out on a schedule.

## What you get on install

| Entity | What it does |
| --- | --- |
| `push_alerts_assistant_status` (cronjob) | Hourly: reads this tenant's own interactions/issues/alerts, POSTs a summary to germany-internal's `collect_tenant_status` endpoint |

## Data flow

```
push_alerts_assistant_status (cronjob, hourly)
        │
        │  reads own tenant via FDE_SELF_READ_API_KEY
        ▼
   (this tenant's own communications/issues/alerts)
        │
        │  POST + shared GLOBAL_MONITORING_PUSH_KEY
        ▼
germany-internal: collect_tenant_status → pushed_tenant_status table
        │
        ▼
germany-internal: global-monitoring-status → dashboard
```

## Reusing this for another tenant

1. Install this plugin on the tenant.
2. Create its own `FDE_SELF_READ_API_KEY`-equivalent secret (a read key for that tenant's own data).
3. Create the same `GLOBAL_MONITORING_PUSH_KEY` value germany-internal already has.
4. Set `self_api_url` and `global_monitoring_collect_url` global variables.
5. Change the hardcoded `TENANT_LABEL` in `code.ts` to that tenant's real name.

No changes needed on the germany-internal (collecting) side — it discovers pushed tenants dynamically from the table.
