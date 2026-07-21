# Wonderful Plugin Template

Minimal starter for building a **Wonderful Marketplace plugin**.

## What you get

- A `manifest.json` and a tiny example plugin under `entities/`
  demonstrating every supported entity type with as little logic as
  possible:
  - `notes.custom_table.json` — one-column table (`text`); the platform adds `created_at` / `updated_at` automatically
  - `add_note.function/` — POST that inserts one row into `notes`
  - `daily_ping.cronjob/` — once-a-day row count
  - `notes_viewer.app/` — lists `notes`, button calls `add_note`
- A package script that builds the inner app, validates the manifest
  against the marketplace's strict server-side rules, and zips
  `dist/<plugin>-<version>.zip` ready to upload.

The bundled sample is `wonderful/example-plugin`. Replace each entity
with your own; the layout and conventions stay the same.

## Quick start

```bash
pnpm install
pnpm package
```

Output: `dist/example-plugin-1.0.0.zip`. Upload via the catalog admin
SPA (**Submissions → Upload**), or install straight onto a dev tenant:

```bash
pnpm package:check     # dry run — validates without writing the zip
pnpm dev-install       # package + install through the controller's dev-install endpoint
```

## Make it yours

1. Edit `manifest.json` — `publisher_id`, `slug`, `version`, `title`,
   `short_description`.
2. Replace `media/icon.png` and `media/screenshots/`.
3. Edit `README-PLUGIN.md` — this is what gets shown on the plugin's
   marketplace listing.
4. Keep, edit, or replace what's under `entities/`. Each entity is named
   `<key>.<type>` so the kind shows in the file tree:
   ```
   entities/
   ├── notes.custom_table.json     # single-file entity
   ├── add_note.function/          # directory entity
   │   ├── entity.json             # no `code` field
   │   └── code.ts                 # inlined into entity at zip time
   ├── daily_ping.cronjob/
   │   ├── entity.json
   │   └── code.ts
   └── notes_viewer.app/
       ├── entity.json
       ├── package.json, vite.config.ts, …
       └── src/
   ```
   - **Single-file shape** (`<key>.<type>.json`) — fits any entity whose
     definition is just JSON.
   - **Directory shape** (`<key>.<type>/` containing `entity.json`) —
     used for apps (carry source) and for functions/cronjobs so handler
     code lives in a real `.ts` file editors can format and lint, not an
     escaped JSON string.
5. `pnpm package` rebuilds.

## Submitting

In the catalog admin SPA, open **Submissions → Upload** and drop
`dist/<plugin>-<version>.zip`. The modal parses `manifest.json`
client-side, registers the plugin row automatically when the slug is new
(publisher comes from the manifest — nothing is typed manually), creates
a draft version, uploads the archive, and submits it for review in one
click. The manifest `version` must exceed the latest published version.

A standalone **Submit for review** button exists only on a submission's
detail page, for re-submitting after a reviewer requests changes.

## Dev-install (fast loop)

`pnpm dev-install` skips the review flow entirely: it packages, POSTs the
zip to the controller's `/api/v1/catalog/plugins/dev-install`, polls the
install job, and prints the resulting apps. Configure via flags, env vars,
or a `.env` file at the repo root:

```bash
WONDERFUL_API_KEY=…                                     # required
WONDERFUL_BASE_URL=http://localhost:5050                # default
WONDERFUL_TARGET_WORKSPACE_ID=00000000-0000-0000-0000-000000000000  # default: General
```

Constraints: the zip must be under 64 MiB; **skill/tool plugins can't be
dev-installed** (the endpoint carries no `target_agent_id` — use the
catalog install endpoints instead); after every dev-install app IDs
regenerate and app permissions reset to `restricted`.

---

## Plugin format reference

Authoritative source for every rule below: the **wonderful** repo
(`~/dev/wonderful`):

- `common/catalog/types/manifest.go`
- `common/catalog/validate/manifest.go`
- `wonderful-controller/components/catalog/handlers/*.go`
- `wonderful-catalog/components/archives/api/api.go`

### Archive layout

```
plugin.zip
├── manifest.json
├── README.md                                  # referenced by manifest.readme_path
├── media/
│   ├── icon.png                               # referenced by manifest.icon_path
│   └── screenshots/...                         # referenced by manifest.screenshot_paths
└── entities/
    ├── <key>.<type>.json                       # single-file entity
    └── <key>.<type>/
        ├── entity.json                         # directory entity
        └── bundle.zip                          # for app entities (referenced by bundle_path)
```

`<type>` is the manifest type name (`custom_table`, `function`, `cronjob`,
`app`, `skill`, `tool`, `agent`, `monitor`). The manifest's `path` field
is the authoritative pointer; the validator doesn't infer the layout from
the suffix.

`code.ts`/`code.js` files inside a `function` or `cronjob` entity
directory **don't** ship in the plugin zip as separate files. The package
script reads them at zip time and inlines their contents as the entity's
`code` field, so the on-zip JSON is the single shape the controller
decoder consumes.

Size caps — three distinct limits:

- `common/catalog/archive/zip.go` (hardcoded, applies everywhere the
  archive is opened): single uncompressed entry ≤ 16 MiB; **total
  uncompressed content ≤ 64 MiB**.
- Catalog admin upload: the zip file itself (compressed) ≤
  `CATALOG_ARCHIVES_MAX_BYTES`, default 100 MiB.
- Controller dev-install: the zip file ≤ 64 MiB (hardcoded).

### `manifest.json`

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `schema_version` | int | yes | must be `1` |
| `publisher_id` | string | yes | matches the publisher segment of `slug`; not in {`admin`, `api`, `internal`} |
| `slug` | string | yes | `^[a-z0-9][a-z0-9-]{0,40}/[a-z0-9][a-z0-9-]{0,60}$` |
| `version` | string | yes | semver per [Masterminds/semver](https://github.com/Masterminds/semver); must strictly increase across published versions |
| `title` | string | yes | non-empty after trim |
| `short_description` | string | yes | non-empty after trim |
| `category` | string | no | if set, one of `Integrations`, `Agent Skills`, `Workflows`, `Knowledge`, `Observability`, `Other` (`common/catalog/types/category.go`) |
| `tags` | string[] | no | free text array |
| `icon_path` | string | no | when set, path inside zip must exist; when omitted the catalog renders a per-category fallback icon |
| `screenshot_paths` | string[] | yes | at least one; each path must exist in zip |
| `readme_path` | string | yes | path inside zip, file must exist — this file becomes the catalog listing's long description (the package script ships `README-PLUGIN.md`'s content there when `readme_path` is the repo default `README.md`) |
| `release_notes` | string | yes | free text shown in the version timeline |
| `entities` | object[] | yes | non-empty; see entity reference below |

#### `entities[]` objects

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `type` | string | yes | one of `custom_table`, `function`, `cronjob`, `app`, `skill`, `tool`, `agent`, `monitor` |
| `key` | string | yes | unique within plugin; used for cross-references |
| `path` | string | yes | path inside zip to the entity's JSON file |
| `depends_on` | string[] | no | resolves to other entity keys; cycles are rejected |

Install order is derived from `depends_on` via topological sort. If a
function writes to a custom_table, declare `depends_on: ["<table key>"]`
on the function so the table exists when the function rolls in.

Family rules (mirrored by the package script):

- **Workspace entities** (`app`, `function`, `cronjob`, `custom_table`,
  `monitor`) install once per workspace. **Agent-asset entities**
  (`skill`, `tool`) install per target agent. A `depends_on` edge can't
  cross the two families — they're materialized in separate scopes.
- An **`agent`** entity must be the **only** entity in its plugin: it
  creates a whole new agent and its repo tree already carries its own
  skills/tools as files.

### Entity types

The on-disk JSON shape of each entity mirrors the controller's
`*EntityFile` decoder structs. Fields not listed are ignored.

#### `custom_table`

Decoder: `wonderful-controller/components/marketplace/handlers/custom_table.go`.

```jsonc
// entities/<key>.custom_table.json
{
  "name": "notes",                 // required, ^[a-zA-Z][a-zA-Z0-9_]{0,63}$
  "description": "…",
  "columns": [                       // required, non-empty
    { "name": "customer_id", "type": "string",  "required": true },
    { "name": "score",       "type": "number",  "required": true },
    { "name": "recorded_at", "type": "date",    "required": true }
  ],
  "seed_rows": [                      // optional
    { "customer_id": "c_1", "score": 0.5, "recorded_at": "2026-05-09" }
  ]
}
```

Column types: `string`, `number`, `boolean`, `date`, `vector`,
`big_vector`. On install the controller creates a real Postgres table in
the tenant's `wonderful_tables` schema, prefixed with the workspace key.
Tenants can ALTER, INSERT, and DROP it freely afterwards.

#### `function`

Decoder: `wonderful-controller/components/marketplace/handlers/function.go`.

```jsonc
// entities/<key>.function/entity.json — handler lives in code.ts
{
  "name": "add_note",                // required
  "description": "…",
  "method": "POST",                  // required, one of GET/POST/PUT/DELETE/PATCH
  "path_slug": "add-note",           // required, ^[a-z0-9-]+$ (no slashes); exposed at /api/v1/functions/<slug>
  "param_mapping": {                  // required object (may be empty)
    "body_params": [
      { "name": "text", "type": "string", "required": true }
    ]
  },
  "is_enabled": true,                 // optional, default true
  "timeout_ms": 5000,                  // optional
  "ports": []                         // optional, dynamic_toolkit ports
}
```

```ts
// entities/<key>.function/code.ts
export default async function handler({ body, context }) {
  await context.tables.notes.insert({ /* … */ });
  return { status: 200, body: { ok: true } };
}
```

The package script inlines the file contents into the entity's `code`
field before adding the JSON to the plugin zip. The shipped artifact has
a single inline `code` string — exactly what the controller's decoder
consumes.

#### `cronjob`

Decoder: `wonderful-controller/components/marketplace/handlers/cronjob.go`.

```jsonc
// entities/<key>.cronjob/entity.json — handler lives in code.ts
{
  "name": "daily_ping",             // required
  "slug": "daily-ping",              // required, must be unique
  "description": "…",
  "cron_schedules": [                 // required, non-empty
    // fields per models.CronSchedule: cron_expression + enabled.
    // NOTE: NOT "expression"/"timezone" — those keys don't bind, leaving the
    // schedule with an empty expression and enabled=false (never auto-runs).
    { "cron_expression": "0 8 * * *", "enabled": true }
  ],
  "is_enabled": true,
  "timeout_ms": 60000,
  "ports": []
}
```

Same runtime as functions, same code-file convention, invoked on schedule
rather than HTTP.

#### `app`

Decoder: `wonderful-controller/components/marketplace/handlers/app.go`.

```jsonc
// entities/<key>.app/entity.json
{
  "name": "notes_viewer",                              // required
  "description": "…",
  "bundle_path": "entities/<key>.app/bundle.zip",      // optional inner bundle
  "preview_image_path": "entities/<key>.app/preview.png", // optional preview tile
  "anonymous_access_enabled": false,                    // optional, default false
  "resource_links": [                                    // optional, default []
    { "type": "table",    "entity_key": "notes" },
    { "type": "function", "entity_key": "add_note" }
  ]
}
```

When `bundle_path` is set, the controller streams those bytes to the apps
service which creates a version + activates it. The bundle is a
secondary zip whose entry point is `app.js` (default export) — produced
by a vite lib-mode build. By convention the source lives next to
`entity.json` (sibling `package.json` + `src/`), and the package script
builds it into `entities/<key>.app/bundle.zip` for you.

When `preview_image_path` is set, the package script ships that image in
the archive and the controller stores it as the app's preview tile on
install (the same preview the manual "upload preview" flow sets), so a
freshly installed app doesn't show a blank tile. By convention it's a
`preview.png` sibling of `entity.json`. Optional; capped at 5 MB. On
upgrade an omitted preview never clears an existing tile.

##### `resource_links`

`resource_links` declares which functions and tables installed by this
plugin the app needs permitted under its asset-session token. The install
pipeline calls `AttachResourceLink` for each entry after the app's bundle
is activated, so the runtime SDK can call `api.invokeFunction("add-note",
…)` or `api.get("/api/v1/custom-tables/notes/rows")` without the tenant
admin manually wiring the links post-install.

Rules — enforced by the manifest validator AND the package script:

| Rule | What it means |
| --- | --- |
| `type ∈ {"function", "table"}` | Mirrors `WonderfulAppResourceType` |
| `entity_key` references another entity in **this** manifest | No cross-plugin refs |
| Referenced entity's type matches | `"function"` → `function` entity; `"table"` → `custom_table` entity |
| `entity_key` also appears in the app entity's `depends_on` | So topological sort guarantees the referenced entity is materialized first |

Row shape gotcha: when the app reads rows back from a custom table, each
row carries its declared columns inside a nested `data` map, plus the
standard id + timestamps on the top level. The text we stored in the
`notes` table arrives as `row.data.text`, not `row.text`. See the example
app's `App.tsx` for the access pattern.

##### `anonymous_access_enabled`

When `true`, the install also flips the app's share-link toggle on so the
tenant admin can mint a `/s/<code>` URL to share with non-Wonderful
users. The install hard-fails if the app's bundle source uses any of
`api.fetch`, `api.get`, `api.post`, `api.put`, or `api.del` — those
methods throw in external mode (the bundle scanner refuses to enable
share-link access on bundles that touch them). Anonymous-capable apps
must talk to the platform only through `api.invokeFunction()`.

Practical consequence: split admin and public surfaces into separate
`app` entities — one with `anonymous_access_enabled: false` that uses the
full SDK for designer / admin views, and one with
`anonymous_access_enabled: true` whose bundle is `invokeFunction`-only.

#### `skill` / `tool` / `agent` / `monitor`

The package script validates the same shape rules the server enforces
(`common/catalog/validate/manifest.go`); the full authoring contracts live
with the platform docs. In brief:

- **`skill`** — a voice-agent skill installed onto chosen agent(s); no
  local checks beyond the manifest-level ones.
- **`tool`** — a programmable tool attached to a sibling `skill` entity:
  `skill_entity_key` must reference a `skill` entity in this plugin AND
  appear in the tool's `depends_on`.
- **`agent`** — a whole new agent created on install. Must be the sole
  entity in the plugin; needs a kebab-case `slug`, a `display_name`, and
  a V2 repo tree (files alongside `entity.json` in its directory — the
  package script ships them — or inline `files`) and/or a `v1` payload.
- **`monitor`** — an Alerts Center monitor. Validated: `name`, `metric`
  (closed enum, minus `TagCount`/`TagRate`/`MetricSuccessRate` which need
  tenant-specific ids), `estimator`, `severity`, optional
  `time_unit`/`interval`, `trigger_conditions` tree, `alert_actions`,
  `active_schedule` (`week_day` + `HH:MM:SS` times), and
  `resource_entity_key` (function-failure metrics only; must reference a
  matching sibling entity that's also in `depends_on`).

Note: `skill`/`tool` plugins install per **agent** and therefore can't be
dev-installed (no `target_agent_id` on that endpoint) — upload them
through the catalog and install via the install endpoints.

### Server-side rejection conditions

The catalog upload endpoint returns **400 Bad Request** with the
actual reason for any of the following — your admin SPA modal shows the
message verbatim:

| Reason | When |
| --- | --- |
| `open zip: …` | The uploaded file isn't a valid zip |
| `read manifest.json: …` | No `manifest.json` at zip root |
| `decode manifest.json: …` | `manifest.json` isn't valid JSON |
| `validate manifest: <rule>` | Any rule above fails |
| `manifest slug "X" does not match URL "Y"` | The plugin row's slug differs from what's in the manifest |
| `archive exceeds N bytes` | Zip over `CATALOG_ARCHIVES_MAX_BYTES` (admin upload) or over 64 MiB (dev-install) |
| `plugin "<slug>" not found` | Only reachable via direct API use — the Submissions → Upload modal registers the plugin row automatically |

Internal failures (S3, DB) stay as `500` with a redacted "Internal server
error" message.

### Versioning

- `version` must be valid semver and **strictly increase** across
  published versions of the same plugin.
- Withdrawn / rejected versions don't free up their version number.

### Apps that import `@wonderful/ui-base`

If your plugin ships an `app` entity whose source imports
`@wonderful/ui-base`, the **host runtime** is the source of truth — not
the latest npm-published `.d.ts`. The host's import map always resolves
the bare `@wonderful/ui-base` specifier to a **frozen** legacy chunk
pinned to **ui-base 0.100.0** (`wonderful-ui/package.json` →
`@wonderful/ui-base-legacy: npm:@wonderful/ui-base@0.100.0`, wired in
`wonderful-ui/src/lib/app-shared-deps.ts`). Newer npm releases (v2+)
describe an API that does **not exist at runtime**: `tsc --noEmit`
passing against v2 types does not stop the app from crashing on mount
(e.g. v2's `Box.Col` compound component is `undefined` in 0.100.0 —
React throws "Element type is invalid" and the host shows "Failed to
load app").

**Pin the tsc devDependency to the runtime version:**

```bash
pnpm --filter ./entities/<key>.app add -D @wonderful/ui-base@0.100.0
```

Keep `@wonderful/ui-base` in vite `external` either way — the pin only
feeds tsc; the host serves the real module at runtime. If a component you
need is missing from 0.100.0, augment locally in
`src/types/ui-base-ext.d.ts` (module-augmentation pattern: start the file
with `import "@wonderful/ui-base";`) — but verify the export actually
exists in the 0.100.0 runtime first.

---

## Roadmap

- `pnpm submit` — push the built zip to the catalog directly via a
  Cloudflare Access service token (dev tenants are covered by
  `pnpm dev-install` already).
- `pnpm dev` — run the entity code locally against a stub Wonderful
  runtime, mirroring `wonderful-app-template`'s `runner/` mode.
- `pnpm pull` — re-hydrate a working tree from an installed version's
  `source/` snapshot (today: `controller-cli apps download --extract`).

## Help

`#marketplace` Slack channel, or open an issue on this repo.
