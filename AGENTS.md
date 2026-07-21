# AGENTS.md

Instructions for AI coding agents (Claude / Codex / Cursor) working inside
this repo. Read first, edit second.

## What this repo is

A **template** for Wonderful Marketplace plugins. Treat it as scaffolding,
not production code. Examples must stay minimal and copy-pasteable —
plugin authors will read the diffs to learn the format, so noise has a
real cost.

## Workflow rules

- Always run `pnpm package` after edits. Surface validator errors
  verbatim — don't paraphrase. The validator's wording mirrors the
  server-side rules so users hit identical phrasing on upload.
- After `pnpm package`, `git status` must be clean (only `dist/`,
  `entities/*.app/dist/`, `entities/*.app/bundle.zip`, `node_modules`
  should ever be modified, and they're all gitignored). If you see a
  tracked file changed by the build, the build is leaking — fix it.
- Don't add a runtime dependency unless you can justify it in one
  sentence in the PR. `adm-zip` is the only intentional dep.

## Source of truth for the plugin contract

The catalog's strict validator and per-entity decoders live in the
**wonderful** repo (`~/dev/wonderful`). Read these files before changing
anything in `manifest.json` or under `entities/`:

- `common/catalog/types/manifest.go` — `PluginManifest` struct and
  schema constants.
- `common/catalog/types/entity_type.go` — closed entity-type enum
  (`app`, `function`, `cronjob`, `custom_table`, `skill`, `tool`,
  `agent`, `monitor`) and the workspace vs agent-asset family split.
- `common/catalog/validate/manifest.go` — strict validator (slug,
  semver, dependency cycle detection, media-path existence, per-entity
  rules for tool/agent/monitor/app-roles, cross-family depends_on).
  `scripts/package.mjs` mirrors it, including the enum sets in its
  "Mirrored enums" block — when the Go side gains a value, add it there
  too or valid plugins start failing local packaging.
- `common/catalog/archive/zip.go` — archive contract and size caps.
- `wonderful-controller/components/catalog/handlers/{function,cronjob,custom_table,app}.go`
  — the on-disk entity JSON shapes (`*EntityFile` structs) that the
  controller decodes at install time.
- `wonderful-catalog/components/archives/api/api.go` — server-side
  upload validation; failures wrap `archives.ErrInvalidArchive` and
  surface as `400` with the actual reason.

When you change an entity JSON shape here, mirror the rule in
`scripts/package.mjs` first — otherwise users get cryptic server-side
rejections instead of fast local errors.

## File budget

- Entity JSONs: keep them short. Comments belong in `code` blocks where
  the runtime executes them, not in the manifest-side metadata.
- README sections: one paragraph + one code block where possible. The
  long-form reference (manifest tables, entity JSON shapes, server-side
  rejection conditions) lives in the back half of `README.md` —
  intentionally one file so authors don't hunt across `docs/`.
- Inline TypeScript inside function/cronjob `code` fields: keep
  dependency-free unless you've already negotiated a runtime allowlist
  with the runner-platform team.

## Repo layout for entities

Entities are named **and** typed by suffix so the file tree shows what
you're looking at without opening the manifest. An entity in
`manifest.json` resolves to either:

- a single file at `entities/<name>.<type>.json` (used for tables and any
  other entity whose definition is just JSON), **or**
- a directory at `entities/<name>.<type>/` whose `entity.json` is the
  manifest-side metadata and whose siblings hold whatever the entity needs
  to build itself:
  - `app` directories carry vite + react source compiled into `bundle.zip`.
  - `function` and `cronjob` directories carry a sibling `code.ts`/`code.js`
    that the package script inlines into the entity JSON's `code` field
    at zip time — keeps the source editor-friendly instead of escaped JSON.
  - `agent` directories carry the new agent's V2 repo tree (skill/tool/
    prompt files) as siblings of `entity.json`; the package script ships
    them all into the zip.

Putting both `code.ts` AND inline `code` on the same entity is an error.
The file is the canonical source for directory-shape entities.

The manifest's `path` field is the explicit pointer; the package script
doesn't infer either layout.

## Build artifacts you must NOT commit

- `dist/`
- `entities/*.app/dist/`
- `entities/*.app/bundle.zip`
- `node_modules/` and `entities/*.app/node_modules/`

`.gitignore` covers these. If you find yourself adding any to the index,
stop — something's wrong.

## When adding a new entity type to the template

1. Read the corresponding handler in
   `~/dev/wonderful/wonderful-controller/components/catalog/handlers/`
   to see exactly which fields the controller decodes.
2. Add the type to `ENTITY_TYPES` and the per-type validation switch in
   `scripts/package.mjs`.
3. Ship a minimal example under `entities/<name>.<type>.json` (single-file
   shape) or `entities/<name>.<type>/entity.json` (directory shape) and
   wire it through `manifest.json`.
4. Add a row to the entity table in `README.md` and a new section in
   the "Entity types" reference further down.

## When adding a new app

1. Create `entities/<name>.app/` mirroring the
   `entities/notes_viewer.app/` shape (vite lib-mode, `src/index.ts`
   default export, externals for react/react-dom/sdk).
2. Inside, put `entity.json` with
   `"bundle_path": "entities/<name>.app/bundle.zip"`. The build script
   enforces that the bundle path is the entity directory's sibling —
   anywhere else fails pre-flight.
3. Reference it from `manifest.json` with
   `"path": "entities/<name>.app/entity.json"`. `pnpm-workspace.yaml`'s
   `entities/*` glob picks it up automatically — no edits needed.

## Self-test before opening a PR

```bash
pnpm install
pnpm package           # must succeed
git status             # must be clean
```

If you have access to the wonderful repo, also run the Go-side validator
against the produced zip — it's the same one the server runs:

```bash
go run /tmp/validate-plugin/main.go dist/example-plugin-1.0.0.zip
# expect: OK <publisher> <slug> v<version> — N entities
```
