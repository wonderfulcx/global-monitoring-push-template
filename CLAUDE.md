# CLAUDE.md — global-monitoring-push-template (the pusher)

The `monitoring_push` cron installed on each monitored tenant. It self-reads the tenant and POSTs a tier-projected snapshot to the hub.

**Repo contract, workflow, entity layout, self-test → `AGENTS.md`.** Do not restate any of it here. This file is only about *how to write code*.

## This repo is the PRODUCER — collection only, never policy

Its job: read raw per-agent facts · enforce the tier · pass the tenant's own detector verdicts through untouched · POST.

**Severity mapping and rollups do NOT belong here.** Every threshold baked into this repo needs a version bump *and a Catalog upload per tenant* to change — Eventim sat on v0.8.1 for days waiting for exactly that. Policy lives in the hub.

Shared read-logic lives in `global-monitoring-core` via the `shared_lib` submodule. **Never copy a function out of it** — move the pin.

## The tier is a data boundary, not a formatting step

- `applyTier()` is enforced **on the source, before anything leaves the tenant**. It is the whole privacy contract.
- **Every new field must be explicitly placed in a tier.** A field that isn't gated leaks at T0. When you add a collector, you are not done until `applyTier` mentions it.
- Additive only: T1 ⊃ T0, T2 ⊃ T1, T3 ⊃ T2.

## Fail loudly — no silent success

- **Any read failure throws.** A broken run must be red, never a green "success" with an error buried in the output. This was explicit feedback and it is not negotiable.
- Log what was actually pushed (the per-window summary), so a run can be audited without re-reading the tenant.
- A failed *health* read can never report healthy. Silence is not health.

## No duplication

- Grep `shared_lib/core.ts` before writing a helper — the read/unwrap/aggregate/secret helpers exist.
- One vocabulary. Don't invent a second severity scale or a second config-reading pattern.
- Config reads go through the one defensive helper (`readGlobal`): `context.globals.get()` **throws** on a missing global, which is what makes optional globals possible. Never call it bare.

## Self-healing config, because humans set these by hand

`gm_self_api_url` has been wrong in production in three distinct ways (`.app` host, trailing slash, pasted path). `normalizeBase()` fixes all three. When you add a hand-entered global, normalise it and log the correction rather than failing the tenant.

## Elegance

- One responsibility per function; pure where it can be pure.
- Prefer deleting to adding. This cron should stay small enough to read in one sitting.
- No real tenant hosts or names — this repo is public. Use placeholders.
- Comments explain *why*. Match the surrounding density.
