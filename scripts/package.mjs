#!/usr/bin/env node
// scripts/package.mjs — build inner apps, validate the plugin manifest
// against the marketplace's strict server-side rules, and produce the
// shippable plugin.zip at dist/<plugin-segment>-<version>.zip.
//
// The validator here mirrors common/catalog/validate/manifest.go in the
// wonderful repo. Keep them in sync when the manifest schema changes.
//
// Convention enforced by this script:
//   - A simple entity is a single file at entities/<name>.<type>.json.
//   - A complex entity is a directory at entities/<name>.<type>/ containing
//     entity.json plus any auxiliary files the entity needs:
//       - apps:                package.json + vite source compiled into
//                              bundle.zip (referenced by entity.bundle_path).
//       - functions/cronjobs:  a sibling `code.ts` (or .js) whose contents
//                              this script inlines as the entity's `code`
//                              field at zip time, so the source stays
//                              editor-friendly instead of being escaped JSON.
//   - The manifest's `path` field is the explicit pointer; the script does
//     not infer either layout, so authors keep full control.

import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = join(REPO_ROOT, "manifest.json");
const PLUGIN_README_FILE = join(REPO_ROOT, "README-PLUGIN.md");
const DIST_DIR = join(REPO_ROOT, "dist");

// Closed entity-type set — mirrors PluginEntityType in
// common/catalog/types/entity_type.go.
const ENTITY_TYPES = new Set([
  "app", "function", "cronjob", "custom_table",
  "skill", "tool", "agent", "monitor",
]);
// Agent-asset entities (skill/tool) install per target agent; everything else
// (including `agent` and `monitor`) rides the workspace-scoped path. Mirrors
// PluginEntityType.IsAgentEntity in common/catalog/types/entity_type.go.
const AGENT_ASSET_TYPES = new Set(["skill", "tool"]);
const RESERVED_PUBLISHERS = new Set(["admin", "api", "internal"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}\/[a-z0-9][a-z0-9-]{0,60}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TABLE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const FUNCTION_PATH_SLUG_RE = /^[a-z0-9-]+$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
const RESERVED_TABLE_COLUMNS = new Set(["created_at", "updated_at"]);
// APP_RESOURCE_LINK_TYPES maps each declared resource_link type to the entity
// type it must reference. Mirrors appResourceLinkTypes in
// common/catalog/validate/manifest.go.
const APP_RESOURCE_LINK_TYPES = {
  function: "function",
  table: "custom_table",
};

// ----------------------------------------------------------------------------
// Mirrored enums — keep in sync with the Go sources of truth. Each set below
// names the Go declaration it copies; when the platform grows a value, add it
// here too or valid plugins will fail local packaging.
// ----------------------------------------------------------------------------
// common/catalog/validate/manifest.go agentSlugPattern
const AGENT_SLUG_RE = /^[a-z0-9-]+$/;
// common/catalog/validate/manifest.go maxAppRoles / appRoleNamePattern
const MAX_APP_ROLES = 20;
const APP_ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// common/models/alert.go AlertMetricType
const ALERT_METRICS = new Set([
  "ActiveInteractions", "TotalInteractions", "Duration", "ForwardAmount",
  "ForwardPercentage", "ToolFailure", "ToolApplicationFailure", "TagCount",
  "TagRate", "MetricSuccessRate", "AgentLatency", "ToolLatency",
  "SlowInteractionRate", "CronFunctionFailure", "ApiFunctionFailure",
  "UserInvited",
]);
// common/catalog/validate/manifest.go monitorUnauthorableMetrics — metric
// families whose alerts reference tenant-specific ids a portable plugin
// can't know ahead of install.
const MONITOR_UNAUTHORABLE_METRICS = new Map([
  ["TagCount", "requires tenant tag ids"],
  ["TagRate", "requires tenant tag ids"],
  ["MetricSuccessRate", "requires a tenant metric id"],
]);
// common/models/alert.go Estimator / Severity / TimeUnit / AlertActionType
const ALERT_ESTIMATORS = new Set(["Average", "Minimum", "Maximum", "LastValue"]);
const ALERT_SEVERITIES = new Set(["High", "Medium", "Low"]);
const ALERT_TIME_UNITS = new Set(["Minutes", "Hours", "Days"]);
const ALERT_ACTION_TYPES = new Set(["email", "sms", "user_email", "group_email", "all_admins"]);
// common/models/alert.go Operator / ComparisonOperator (trigger_conditions tree)
const ALERT_OPERATORS = new Set(["And", "Or"]);
const ALERT_COMPARISON_OPERATORS = new Set([
  "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo",
  "EqualTo", "NoData",
]);
// common/models/alert.go Weekday; times parse as HH:MM:SS
// (consts.TimeWithSecondsFormat "15:04:05").
const ALERT_WEEKDAYS = new Set([
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
]);
const TIME_WITH_SECONDS_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
// common/models/alert.go FunctionMetricResourceTypes — function-failure
// metrics that may scope to a sibling entity via resource_entity_key.
const FUNCTION_METRIC_RESOURCE_TYPES = {
  CronFunctionFailure: "cronjob",
  ApiFunctionFailure: "function",
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}
function info(message) { console.log(`· ${message}`); }
function ok(message) { console.log(`✓ ${message}`); }

function readJson(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) { fail(`cannot read ${relative(REPO_ROOT, path)}: ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { fail(`${relative(REPO_ROOT, path)} is not valid JSON: ${err.message}`); }
}

function archivePathExists(p) {
  // p is the manifest-style relative archive path (slash-separated).
  const fsPath = join(REPO_ROOT, p.split("/").join(sep));
  return existsSync(fsPath) && statSync(fsPath).isFile();
}

// ----------------------------------------------------------------------------
// App-source bundling — mirrors wonderful-app-template/scripts/package.js.
//
// The app's bundle.zip ships the built artifacts at the root (app.js,
// style.css, …) AND a snapshot of the app's source under `source/`. The
// runtime loader only reads root files, but the marketplace diff viewer
// surfaces the `source/` snapshot so reviewers see real source instead of
// minified output. Keep this list in sync with the app template — drift
// would mean some apps ship source and others don't.
// ----------------------------------------------------------------------------
const APP_SOURCE_PREFIX = "source/";
const APP_SOURCE_DIRS = ["src", "runner", "dev", "scripts"];
const APP_SOURCE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  ".npmrc",
  "AGENTS.md",
  "README.md",
];
const APP_SOURCE_EXCLUDE_BASENAMES = new Set([
  "node_modules",
  "dist",
  "runner-dist",
  ".git",
  ".DS_Store",
  ".env",
  ".env.local",
]);

function* walkAppSource(rootDir) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (APP_SOURCE_EXCLUDE_BASENAMES.has(entry.name)) continue;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAppSource(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function collectAppSourceEntries(appDir) {
  const out = [];
  for (const name of APP_SOURCE_FILES) {
    const abs = join(appDir, name);
    if (existsSync(abs) && statSync(abs).isFile()) {
      out.push({ abs, archivePath: APP_SOURCE_PREFIX + name });
    }
  }
  for (const dir of APP_SOURCE_DIRS) {
    const abs = join(appDir, dir);
    if (!existsSync(abs)) continue;
    for (const filePath of walkAppSource(abs)) {
      const rel = relative(appDir, filePath).split(sep).join("/");
      out.push({ abs: filePath, archivePath: APP_SOURCE_PREFIX + rel });
    }
  }
  out.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  return out;
}

// ----------------------------------------------------------------------------
// Step 1 — build any inner app referenced by an app entity.
// ----------------------------------------------------------------------------
function buildApp(entity, entityFile) {
  // The app source lives in the same directory as the entity.json. We expect
  // a package.json there (so pnpm --filter can target it) and bundle_path to
  // point at <entity-dir>/bundle.zip.
  const entityPath = entity.path.split("/").join(sep);
  const entityDir = dirname(join(REPO_ROOT, entityPath));
  const entityDirPosix = relative(REPO_ROOT, entityDir).split(sep).join("/");
  const expectedBundle = `${entityDirPosix}/bundle.zip`;

  if (entityFile.bundle_path !== expectedBundle) {
    fail(
      `app ${entity.key}: bundle_path ${JSON.stringify(entityFile.bundle_path)} ` +
        `must equal ${JSON.stringify(expectedBundle)} (sibling of entity.json)`,
    );
  }
  if (!existsSync(join(entityDir, "package.json"))) {
    fail(
      `app ${entity.key}: ${entityDirPosix}/package.json missing — apps that ship a bundle must be a workspace package`,
    );
  }

  info(`building app ${entity.key} at ${entityDirPosix}`);
  const filterArg = `./${entityDirPosix}`;
  const build = spawnSync("pnpm", ["--filter", filterArg, "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    fail(`pnpm --filter ${filterArg} build exited with ${build.status}`);
  }

  const distDir = join(entityDir, "dist");
  if (!existsSync(distDir)) {
    fail(`expected build output at ${relative(REPO_ROOT, distDir)} but the directory is missing`);
  }

  const inner = new AdmZip();
  inner.addLocalFolder(distDir);

  // Snapshot source files under `source/` so the marketplace diff viewer can
  // show real diffs instead of minified bundles. The runtime loader ignores
  // anything outside the bundle root, so this is purely review-time payload.
  // Opt out with BUNDLE_INCLUDE_SOURCE=false (e.g. for fully obfuscated apps).
  const includeSource = process.env.BUNDLE_INCLUDE_SOURCE !== "false";
  let sourceCount = 0;
  if (includeSource) {
    for (const sourceEntry of collectAppSourceEntries(entityDir)) {
      inner.addFile(sourceEntry.archivePath, readFileSync(sourceEntry.abs));
      sourceCount++;
    }
  }

  const outFs = join(REPO_ROOT, expectedBundle.split("/").join(sep));
  inner.writeZip(outFs);
  ok(
    sourceCount > 0
      ? `wrote ${expectedBundle} (+${sourceCount} source files)`
      : `wrote ${expectedBundle}`,
  );
}

// ----------------------------------------------------------------------------
// Step 2 — validate the manifest.
// ----------------------------------------------------------------------------
function validateManifest(manifest) {
  if (manifest.schema_version !== 1) {
    fail(`manifest.schema_version must be 1 (got ${JSON.stringify(manifest.schema_version)})`);
  }
  if (typeof manifest.slug !== "string" || !SLUG_RE.test(manifest.slug)) {
    fail(
      `manifest.slug ${JSON.stringify(manifest.slug)} does not match <publisher>/<plugin> shape ` +
        `(lowercase kebab, publisher ≤41 chars, plugin ≤61 chars)`,
    );
  }
  const [publisher] = manifest.slug.split("/");
  if (RESERVED_PUBLISHERS.has(publisher)) fail(`publisher ${JSON.stringify(publisher)} is reserved`);
  if (manifest.publisher_id !== publisher) {
    fail(
      `manifest.publisher_id ${JSON.stringify(manifest.publisher_id)} does not match slug publisher ${JSON.stringify(publisher)}`,
    );
  }
  if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)) {
    fail(`manifest.version ${JSON.stringify(manifest.version)} is not valid semver`);
  }
  if (!manifest.title || !manifest.title.trim()) fail("manifest.title is required");
  if (!manifest.short_description || !manifest.short_description.trim()) {
    fail("manifest.short_description is required");
  }
  // category is optional, but when set must be one of the closed catalog set
  // (common/catalog/types/category.go). A free-form value is rejected on upload.
  const PLUGIN_CATEGORIES = [
    "Integrations",
    "Agent Skills",
    "Workflows",
    "Knowledge",
    "Observability",
    "Other",
  ];
  if (
    manifest.category != null &&
    String(manifest.category).trim() !== "" &&
    !PLUGIN_CATEGORIES.includes(manifest.category)
  ) {
    fail(
      `manifest.category ${JSON.stringify(manifest.category)} is not one of ` +
        PLUGIN_CATEGORIES.map((c) => JSON.stringify(c)).join(", "),
    );
  }
  // icon_path is optional (matches the server validator): when omitted the
  // catalog renders a per-category fallback icon. Only validate it when set.
  if (manifest.icon_path && !archivePathExists(manifest.icon_path)) {
    fail(`manifest.icon_path ${JSON.stringify(manifest.icon_path)} not found in repo`);
  }
  if (!manifest.readme_path) fail("manifest.readme_path is required");
  // README path resolves against the in-repo file. The package step rewrites
  // README-PLUGIN.md → README.md inside the zip, so we accept either name in
  // the source tree as long as the manifest declares the in-zip path.
  const readmeOK =
    archivePathExists(manifest.readme_path) ||
    (manifest.readme_path === "README.md" && existsSync(PLUGIN_README_FILE));
  if (!readmeOK) {
    fail(`manifest.readme_path ${JSON.stringify(manifest.readme_path)} not found in repo`);
  }
  if (!Array.isArray(manifest.screenshot_paths) || manifest.screenshot_paths.length === 0) {
    fail("manifest.screenshot_paths must declare at least one screenshot");
  }
  for (const sp of manifest.screenshot_paths) {
    if (!archivePathExists(sp)) {
      fail(`manifest screenshot ${JSON.stringify(sp)} not found in repo`);
    }
  }

  // Install-time config the plugin's entities read at runtime. Mirrors
  // common/catalog/validate/manifest.go so a bad declaration fails locally
  // instead of on upload. (Names are referenced as secret://… / context.*.get.)
  const CONFIG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
  // Mirrors models.SecretTypeName (common/models/secret_types.go).
  const SECRET_TYPES = new Set([
    "API Key", "Bearer Token", "Basic Auth", "OAuth2", "HTTP Headers",
    "Certificate", "AWS Credentials", "Azure Storage Credentials",
    "GCP Service Account", "LiveKit", "ElevenLabs", "PGP Key Pair", "Other",
  ]);
  const GLOBAL_VAR_TYPES = new Set(["string", "number", "boolean", "json", "enum"]);
  const seenSecret = new Set();
  (manifest.required_secrets ?? []).forEach((r, i) => {
    if (!CONFIG_NAME_RE.test(r?.name ?? "")) {
      fail(`required_secrets[${i}] name ${JSON.stringify(r?.name)} is invalid (must match ${CONFIG_NAME_RE})`);
    }
    if (seenSecret.has(r.name)) fail(`required_secrets[${i}] name ${JSON.stringify(r.name)} is duplicated`);
    seenSecret.add(r.name);
    if (!r.display_name || !String(r.display_name).trim()) {
      fail(`required_secrets[${i}] ${JSON.stringify(r.name)}: display_name is required`);
    }
    if (!SECRET_TYPES.has(r.secret_type)) {
      fail(`required_secrets[${i}] ${JSON.stringify(r.name)}: secret_type ${JSON.stringify(r.secret_type)} is not a known SecretType`);
    }
  });
  const seenVar = new Set();
  (manifest.required_global_variables ?? []).forEach((r, i) => {
    if (!CONFIG_NAME_RE.test(r?.name ?? "")) {
      fail(`required_global_variables[${i}] name ${JSON.stringify(r?.name)} is invalid (must match ${CONFIG_NAME_RE})`);
    }
    if (seenVar.has(r.name)) fail(`required_global_variables[${i}] name ${JSON.stringify(r.name)} is duplicated`);
    seenVar.add(r.name);
    if (!r.display_name || !String(r.display_name).trim()) {
      fail(`required_global_variables[${i}] ${JSON.stringify(r.name)}: display_name is required`);
    }
    if (!GLOBAL_VAR_TYPES.has(r.type)) {
      fail(`required_global_variables[${i}] ${JSON.stringify(r.name)}: type ${JSON.stringify(r.type)} is not a known GlobalVariableType`);
    }
    if (r.type === "enum" && (!Array.isArray(r.enum_options) || r.enum_options.length === 0)) {
      fail(`required_global_variables[${i}] ${JSON.stringify(r.name)}: enum type requires enum_options`);
    }
  });

  if (!Array.isArray(manifest.entities) || manifest.entities.length === 0) {
    fail("manifest.entities must declare at least one entity");
  }

  const entitiesByKey = new Map();
  for (const e of manifest.entities) {
    if (!ENTITY_TYPES.has(e.type)) {
      fail(`entity ${JSON.stringify(e.key)} has unsupported type ${JSON.stringify(e.type)}`);
    }
    if (!e.key || typeof e.key !== "string") fail("entity key is required");
    if (entitiesByKey.has(e.key)) fail(`entity key ${JSON.stringify(e.key)} is duplicated`);
    entitiesByKey.set(e.key, e);
    if (!e.path || typeof e.path !== "string") fail(`entity ${JSON.stringify(e.key)} is missing path`);
    if (!archivePathExists(e.path)) {
      fail(`entity ${JSON.stringify(e.key)} references missing file ${JSON.stringify(e.path)}`);
    }
  }
  for (const e of manifest.entities) {
    for (const dep of e.depends_on ?? []) {
      if (!entitiesByKey.has(dep)) {
        fail(`entity ${JSON.stringify(e.key)} depends on unknown entity ${JSON.stringify(dep)}`);
      }
    }
  }
  detectCycle(manifest.entities);

  // The `agent` entity creates a whole new agent and carries its own repo
  // tree, so it must be the only entity in its plugin (mirrors
  // common/catalog/validate/manifest.go).
  if (manifest.entities.length > 1) {
    for (const e of manifest.entities) {
      if (e.type === "agent") {
        fail(
          `entity ${JSON.stringify(e.key)} is an "agent" entity, which must be the only entity ` +
            `in its plugin (found ${manifest.entities.length} entities)`,
        );
      }
    }
  }

  // Workspace entities and agent-asset entities (skill/tool) are materialized
  // in separate scopes on install — workspace entities once per workspace,
  // agent assets per target agent — so a depends_on edge can never be
  // satisfied across the two families.
  for (const e of manifest.entities) {
    for (const dep of e.depends_on ?? []) {
      if (AGENT_ASSET_TYPES.has(entitiesByKey.get(dep).type) !== AGENT_ASSET_TYPES.has(e.type)) {
        fail(
          `entity ${JSON.stringify(e.key)} depends on ${JSON.stringify(dep)} across the agent/workspace boundary; ` +
            `skill/tool and app/function/cronjob/custom_table entities are installed separately and can't depend on each other`,
        );
      }
    }
  }

  for (const e of manifest.entities) {
    const entityFile = readJson(join(REPO_ROOT, e.path.split("/").join(sep)));
    switch (e.type) {
      case "function":
        if (!entityFile.name) fail(`function ${e.key}: name is required`);
        if (!HTTP_METHODS.has(entityFile.method)) {
          fail(
            `function ${e.key}: method ${JSON.stringify(entityFile.method)} must be one of ${[...HTTP_METHODS].join(", ")}`,
          );
        }
        if (!entityFile.path_slug) fail(`function ${e.key}: path_slug is required`);
        if (!FUNCTION_PATH_SLUG_RE.test(entityFile.path_slug)) {
          fail(
            `function ${e.key}: path_slug ${JSON.stringify(entityFile.path_slug)} must match ^[a-z0-9-]+$ ` +
              `(lowercase letters, numbers, and hyphens only — no slashes)`,
          );
        }
        if (!entityFile.param_mapping) fail(`function ${e.key}: param_mapping is required`);
        break;
      case "cronjob":
        if (!entityFile.name) fail(`cronjob ${e.key}: name is required`);
        if (!entityFile.slug) fail(`cronjob ${e.key}: slug is required`);
        if (!Array.isArray(entityFile.cron_schedules) || entityFile.cron_schedules.length === 0) {
          fail(`cronjob ${e.key}: cron_schedules must be a non-empty array`);
        }
        // Schedule entries decode into models.CronSchedule: cron_expression + enabled.
        // The legacy template shipped expression/timezone, which silently don't bind
        // (empty expression + enabled=false → schedule never runs). Catch it here.
        for (const [i, sched] of entityFile.cron_schedules.entries()) {
          if (!sched || typeof sched.cron_expression !== "string" || !sched.cron_expression.trim()) {
            fail(
              `cronjob ${e.key}: cron_schedules[${i}] needs a non-empty "cron_expression" ` +
                `(not "expression"; there is no "timezone" field — see models.CronSchedule)`,
            );
          }
          if (sched.enabled !== true) {
            fail(`cronjob ${e.key}: cron_schedules[${i}] needs "enabled": true or it won't run`);
          }
        }
        break;
      case "custom_table":
        if (!entityFile.name || !TABLE_NAME_RE.test(entityFile.name)) {
          fail(
            `custom_table ${e.key}: name ${JSON.stringify(entityFile.name)} must match ^[a-zA-Z][a-zA-Z0-9_]{0,63}$`,
          );
        }
        if (!Array.isArray(entityFile.columns) || entityFile.columns.length === 0) {
          fail(`custom_table ${e.key}: columns must be a non-empty array`);
        }
        for (const col of entityFile.columns) {
          if (RESERVED_TABLE_COLUMNS.has(col.name)) {
            fail(
              `custom_table ${e.key}: column name ${JSON.stringify(col.name)} is reserved ` +
                `(the platform adds it to every custom table automatically)`,
            );
          }
        }
        break;
      case "app": {
        if (!entityFile.name) fail(`app ${e.key}: name is required`);
        if (entityFile.bundle_path && !archivePathExists(entityFile.bundle_path)) {
          fail(`app ${e.key}: bundle_path ${JSON.stringify(entityFile.bundle_path)} not found in repo`);
        }
        if (entityFile.preview_image_path && !archivePathExists(entityFile.preview_image_path)) {
          fail(`app ${e.key}: preview_image_path ${JSON.stringify(entityFile.preview_image_path)} not found in repo`);
        }
        const declaredRoles = validateAppRoles(e, entityFile);
        validateAppResourceLinks(e, entityFile, entitiesByKey, declaredRoles);
        break;
      }
      case "tool":
        validateToolEntity(e, entityFile, entitiesByKey);
        break;
      case "agent":
        validateAgentEntity(e, entityFile);
        break;
      case "monitor":
        validateMonitorEntity(e, entityFile, entitiesByKey);
        break;
      case "skill":
        // No per-entity checks beyond the manifest-level ones (matches the
        // server: validateManifestEntities skips skill).
        break;
    }
  }
}

// validateAppResourceLinks mirrors validateAppEntity in
// common/catalog/validate/manifest.go. Each resource_links[*] must:
//   1. have a known type ("function" or "table"),
//   2. reference an entity declared in this manifest,
//   3. point at an entity of the matching kind, and
//   4. be listed in the app entity's depends_on so the install pipeline's
//      topological sort guarantees the referenced entity is already
//      materialized when the app handler runs.
// `declaredRoles` is the Set returned by validateAppRoles (null when the app
// declares no roles block) — allowed_roles entries must resolve against it.
function validateAppResourceLinks(manifestEntity, entityFile, entitiesByKey, declaredRoles) {
  const links = entityFile.resource_links;
  if (links === undefined) return;
  if (!Array.isArray(links)) {
    fail(`app ${manifestEntity.key}: resource_links must be an array`);
  }
  const dependsOn = new Set(manifestEntity.depends_on ?? []);
  links.forEach((link, i) => {
    const where = `app ${manifestEntity.key}: resource_links[${i}]`;
    const expectedType = APP_RESOURCE_LINK_TYPES[link?.type];
    if (!expectedType) {
      fail(`${where}: type ${JSON.stringify(link?.type)} must be one of "function", "table"`);
    }
    if (!link.entity_key || typeof link.entity_key !== "string") {
      fail(`${where}: entity_key is required`);
    }
    const referenced = entitiesByKey.get(link.entity_key);
    if (!referenced) {
      fail(`${where}: entity_key ${JSON.stringify(link.entity_key)} is not a known entity in this plugin`);
    }
    if (referenced.type !== expectedType) {
      fail(
        `${where}: entity_key ${JSON.stringify(link.entity_key)} is type ${referenced.type}, expected ${expectedType}`,
      );
    }
    if (!dependsOn.has(link.entity_key)) {
      fail(`${where}: entity_key ${JSON.stringify(link.entity_key)} must also appear in depends_on`);
    }
    if (Array.isArray(link.allowed_roles) && link.allowed_roles.length > 0) {
      if (expectedType !== "function") {
        fail(`${where}: allowed_roles applies to function links only`);
      }
      if (!declaredRoles) {
        fail(`${where}: allowed_roles requires a roles block on the app entity`);
      }
      for (const role of link.allowed_roles) {
        if (!declaredRoles.has(role)) {
          fail(`${where}: allowed_roles entry ${JSON.stringify(role)} is not a declared role`);
        }
      }
    }
  });
}

// validateAppRoles mirrors the roles-block rules in validateAppEntity
// (common/catalog/validate/manifest.go). Returns the Set of declared role
// names, or null when the app declares no roles block.
function validateAppRoles(manifestEntity, entityFile) {
  const roles = entityFile.roles;
  if (roles == null) return null;
  const where = `app ${manifestEntity.key}: roles`;
  if (!Array.isArray(roles.roles) || roles.roles.length === 0) {
    fail(`${where}: at least one role is required`);
  }
  if (roles.roles.length > MAX_APP_ROLES) {
    fail(`${where}: an app can declare at most ${MAX_APP_ROLES} roles`);
  }
  const declared = new Set();
  roles.roles.forEach((name, i) => {
    if (typeof name !== "string" || !APP_ROLE_NAME_RE.test(name)) {
      fail(`${where}[${i}]: name ${JSON.stringify(name)} must match ${APP_ROLE_NAME_RE.source}`);
    }
    if (declared.has(name)) fail(`${where}[${i}]: duplicate role name ${JSON.stringify(name)}`);
    declared.add(name);
  });
  if (!declared.has(roles.default_role)) {
    fail(`${where}: default_role ${JSON.stringify(roles.default_role)} is not one of the declared roles`);
  }
  return declared;
}

// validateToolEntity mirrors the server rule: a tool's skill_entity_key must
// reference a sibling `skill` entity in this plugin and also appear in the
// tool's depends_on, so the topological sort materializes the skill before
// the tool handler resolves its id.
function validateToolEntity(manifestEntity, entityFile, entitiesByKey) {
  const where = `tool ${manifestEntity.key}`;
  if (!entityFile.skill_entity_key) fail(`${where}: skill_entity_key is required`);
  const referenced = entitiesByKey.get(entityFile.skill_entity_key);
  if (!referenced) {
    fail(`${where}: skill_entity_key ${JSON.stringify(entityFile.skill_entity_key)} is not a known entity in this plugin`);
  }
  if (referenced.type !== "skill") {
    fail(`${where}: skill_entity_key ${JSON.stringify(entityFile.skill_entity_key)} is type ${referenced.type}, expected skill`);
  }
  if (!(manifestEntity.depends_on ?? []).includes(entityFile.skill_entity_key)) {
    fail(`${where}: skill_entity_key ${JSON.stringify(entityFile.skill_entity_key)} must also appear in depends_on`);
  }
}

// entityDirSiblings lists the files shipping alongside a directory-shape
// entity's JSON (entities/<name>.<type>/…) as {abs, archivePath}. For an
// `agent` entity this is its V2 repo tree. Single-file entities have none.
function entityDirSiblings(entityPath) {
  const parts = entityPath.split("/");
  if (parts.length < 3) return []; // single-file shape (entities/<name>.<type>.json)
  const entityDir = dirname(join(REPO_ROOT, entityPath.split("/").join(sep)));
  const entityDirPosix = parts.slice(0, -1).join("/");
  const out = [];
  for (const filePath of walkAppSource(entityDir)) {
    const rel = relative(entityDir, filePath).split(sep).join("/");
    const archivePath = `${entityDirPosix}/${rel}`;
    if (archivePath === entityPath) continue;
    out.push({ abs: filePath, archivePath });
  }
  out.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  return out;
}

// validateAgentEntity mirrors the server's agent-entity shape rules: an
// ascii-kebab slug + display_name, and at least one runtime payload — a V2
// repo tree (files alongside the entity JSON, or inline `files`) and/or a
// `v1` (database-backed) definition.
function validateAgentEntity(manifestEntity, entityFile) {
  const where = `agent ${manifestEntity.key}`;
  if (typeof entityFile.slug !== "string" || !AGENT_SLUG_RE.test(entityFile.slug)) {
    fail(`${where}: slug ${JSON.stringify(entityFile.slug)} is invalid (must match ${AGENT_SLUG_RE.source})`);
  }
  if (!entityFile.display_name || !String(entityFile.display_name).trim()) {
    fail(`${where}: display_name is required`);
  }
  const hasInlineFiles =
    entityFile.files && typeof entityFile.files === "object" && Object.keys(entityFile.files).length > 0;
  const hasSiblings = entityDirSiblings(manifestEntity.path).length > 0;
  if (!hasInlineFiles && !hasSiblings && !entityFile.v1) {
    fail(
      `${where}: agent entity must declare a V2 repo tree (files alongside the entity JSON ` +
        `in its directory, or inline "files") or a "v1" (database-backed) definition`,
    );
  }
}

// validateMonitorEntity mirrors validateMonitorEntity in
// common/catalog/validate/manifest.go: the plugin-authorable subset of an
// Alerts Center monitor, minus metric families that need tenant-specific ids.
function validateMonitorEntity(manifestEntity, entityFile, entitiesByKey) {
  const where = `monitor ${manifestEntity.key}`;
  if (!entityFile.name || !String(entityFile.name).trim()) fail(`${where}: name is required`);
  if (!ALERT_METRICS.has(entityFile.metric)) {
    fail(`${where}: invalid metric ${JSON.stringify(entityFile.metric)}`);
  }
  const unauthorable = MONITOR_UNAUTHORABLE_METRICS.get(entityFile.metric);
  if (unauthorable) {
    fail(`${where}: metric ${JSON.stringify(entityFile.metric)} is not supported in a plugin monitor: it ${unauthorable}`);
  }
  if (!ALERT_ESTIMATORS.has(entityFile.estimator)) {
    fail(`${where}: invalid estimator ${JSON.stringify(entityFile.estimator)}`);
  }
  if (!ALERT_SEVERITIES.has(entityFile.severity)) {
    fail(`${where}: invalid severity ${JSON.stringify(entityFile.severity)}`);
  }
  if (entityFile.time_unit != null && !ALERT_TIME_UNITS.has(entityFile.time_unit)) {
    fail(`${where}: invalid time_unit ${JSON.stringify(entityFile.time_unit)}`);
  }
  if (entityFile.interval != null && !(Number(entityFile.interval) > 0)) {
    fail(`${where}: interval must be positive`);
  }
  if (entityFile.metric === "ToolLatency" && (!Array.isArray(entityFile.tool_names) || entityFile.tool_names.length === 0)) {
    fail(`${where}: tool_names is required for the ToolLatency metric`);
  }
  validateMonitorConditionNode(where, entityFile.trigger_conditions);
  // alert_actions is optional — when omitted the install defaults the
  // recipient to the installing user.
  (entityFile.alert_actions ?? []).forEach((action, i) => {
    if (!ALERT_ACTION_TYPES.has(action?.type)) {
      fail(`${where}: alert_actions[${i}] has invalid type ${JSON.stringify(action?.type)}`);
    }
    if (!action.value || !String(action.value).trim()) {
      fail(`${where}: alert_actions[${i}] value is required`);
    }
  });
  for (const entry of entityFile.active_schedule ?? []) {
    if (!ALERT_WEEKDAYS.has(entry?.week_day)) {
      fail(`${where}: active_schedule has invalid weekday ${JSON.stringify(entry?.week_day)}`);
    }
    for (const field of ["start_time", "end_time"]) {
      if (typeof entry[field] !== "string" || !TIME_WITH_SECONDS_RE.test(entry[field])) {
        fail(`${where}: active_schedule ${field} for ${entry.week_day} must be HH:MM:SS (got ${JSON.stringify(entry[field])})`);
      }
    }
  }
  validateMonitorResourceLink(where, manifestEntity, entityFile, entitiesByKey);
}

// Threshold tree: operator nodes need a valid logical operator + children and
// no comparison operator; leaf nodes need a valid comparison operator and no
// children.
function validateMonitorConditionNode(where, node) {
  if (node == null) fail(`${where}: trigger_conditions must be provided`);
  if (node.operator != null) {
    if (!ALERT_OPERATORS.has(node.operator)) {
      fail(`${where}: invalid trigger operator ${JSON.stringify(node.operator)}`);
    }
    if (!Array.isArray(node.children) || node.children.length === 0) {
      fail(`${where}: trigger operator nodes must contain children`);
    }
    if (node.comparison_operator) {
      fail(`${where}: trigger operator nodes cannot include a comparison operator`);
    }
    for (const child of node.children) validateMonitorConditionNode(where, child);
    return;
  }
  if (!ALERT_COMPARISON_OPERATORS.has(node.comparison_operator)) {
    fail(`${where}: invalid trigger comparison operator ${JSON.stringify(node.comparison_operator)}`);
  }
  if (Array.isArray(node.children) && node.children.length > 0) {
    fail(`${where}: trigger comparison nodes cannot contain children`);
  }
}

// A monitor scoped to a sibling entity must use a function-failure metric,
// reference an entity of the matching kind, and list it in depends_on.
function validateMonitorResourceLink(where, manifestEntity, entityFile, entitiesByKey) {
  const key = entityFile.resource_entity_key;
  if (!key) return;
  const wantType = FUNCTION_METRIC_RESOURCE_TYPES[entityFile.metric];
  if (!wantType) {
    fail(`${where}: resource_entity_key is only valid for function-failure metrics, not ${JSON.stringify(entityFile.metric)}`);
  }
  const referenced = entitiesByKey.get(key);
  if (!referenced) {
    fail(`${where}: resource_entity_key ${JSON.stringify(key)} is not a known entity in this plugin`);
  }
  if (referenced.type !== wantType) {
    fail(
      `${where}: metric ${JSON.stringify(entityFile.metric)} must scope to a ${JSON.stringify(wantType)} entity, ` +
        `but resource_entity_key ${JSON.stringify(key)} is ${JSON.stringify(referenced.type)}`,
    );
  }
  if (!(manifestEntity.depends_on ?? []).includes(key)) {
    fail(`${where}: resource_entity_key ${JSON.stringify(key)} must also appear in depends_on`);
  }
}

function detectCycle(entities) {
  const color = new Map();
  const deps = new Map();
  for (const e of entities) {
    color.set(e.key, "white");
    deps.set(e.key, e.depends_on ?? []);
  }
  const path = [];
  const visit = (node) => {
    color.set(node, "grey");
    path.push(node);
    for (const next of deps.get(node) ?? []) {
      const c = color.get(next);
      if (c === "grey") fail(`entity DependsOn graph has a cycle: ${[...path, next].join(" -> ")}`);
      if (c === "white") visit(next);
    }
    color.set(node, "black");
    path.pop();
  };
  for (const e of entities) {
    if (color.get(e.key) === "white") visit(e.key);
  }
}

// ----------------------------------------------------------------------------
// Step 3 — assemble the plugin.zip.
//
// Only manifest-referenced paths are added. Source code under
// entities/<name>/ (package.json, src/, vite.config.ts, …) is NOT shipped —
// only the entity.json sibling and the built bundle.zip make it into the
// final archive.
// ----------------------------------------------------------------------------
// Read the sibling code file for a function/cronjob entity, if any.
// Looks for `code.ts` then `code.js` in the entity's directory. Returns
// null when the entity is a single-file shape (no directory) or no sibling
// is present, in which case the entity's inline `code` (if any) is used
// as-is.
// Marker a function/cronjob code.ts can place on its own line to pull in the
// shared read-logic from the shared_lib submodule. Replaced with the verbatim
// contents of shared_lib/core.ts at package time (functions ship as a single
// inlined string and can't import across files at runtime).
const INLINE_CORE_MARKER = "// @@inline-core";
const CORE_FILE = join(REPO_ROOT, "shared_lib", "core.ts");

function inlineSharedCore(contents, entityKey) {
  if (!contents.includes(INLINE_CORE_MARKER)) return contents;
  if (!existsSync(CORE_FILE)) {
    fail(
      `${entityKey}: code references ${INLINE_CORE_MARKER} but shared_lib/core.ts is missing — ` +
        `run \`git submodule update --init\``,
    );
  }
  const core = readFileSync(CORE_FILE, "utf8");
  // Replace the first marker occurrence; leave any others (there shouldn't be)
  // untouched so a stray marker in a string doesn't double-inline.
  return contents.replace(INLINE_CORE_MARKER, core);
}

function readSiblingCode(entityPath, entityKey) {
  const entityDir = dirname(join(REPO_ROOT, entityPath.split("/").join(sep)));
  for (const candidate of ["code.ts", "code.js"]) {
    const fsPath = join(entityDir, candidate);
    if (existsSync(fsPath) && statSync(fsPath).isFile()) {
      return { path: candidate, contents: inlineSharedCore(readFileSync(fsPath, "utf8"), entityKey) };
    }
  }
  return null;
}

function buildPluginZip(manifest) {
  const zip = new AdmZip();

  zip.addLocalFile(MANIFEST_FILE);

  // The file shipped at readme_path becomes the plugin's catalog long
  // description. README-PLUGIN.md is the canonical product copy: when the
  // manifest points at the repo default README.md (the developer doc), ship
  // README-PLUGIN.md's content at that path instead so dev docs never leak
  // into the catalog listing. A custom readme_path ships verbatim.
  const inRepoReadme =
    manifest.readme_path === "README.md" && existsSync(PLUGIN_README_FILE)
      ? PLUGIN_README_FILE
      : join(REPO_ROOT, manifest.readme_path.split("/").join(sep));
  zip.addFile(manifest.readme_path, readFileSync(inRepoReadme));

  zip.addLocalFolder(join(REPO_ROOT, "media"), "media");

  for (const e of manifest.entities) {
    const entityFs = join(REPO_ROOT, e.path.split("/").join(sep));

    if (e.type === "function" || e.type === "cronjob") {
      // Inline the sibling code file (if any) into the entity JSON so the
      // shipped artifact is what the controller's *EntityFile decoder
      // expects: a single JSON with `code` set inline.
      const entityFile = readJson(entityFs);
      const sibling = readSiblingCode(e.path, e.key);
      if (sibling) {
        if (entityFile.code !== undefined) {
          fail(
            `${e.type} ${e.key}: both ${sibling.path} and inline \`code\` present — ` +
              `pick one (the file is the canonical source for directory-shape entities)`,
          );
        }
        entityFile.code = sibling.contents;
      }
      zip.addFile(e.path, Buffer.from(JSON.stringify(entityFile, null, 2) + "\n"));
    } else {
      zip.addFile(e.path, readFileSync(entityFs));
      if (e.type === "app") {
        const entityFile = readJson(entityFs);
        if (entityFile.bundle_path) {
          const bundleFs = join(REPO_ROOT, entityFile.bundle_path.split("/").join(sep));
          zip.addFile(entityFile.bundle_path, readFileSync(bundleFs));
        }
        if (entityFile.preview_image_path) {
          const previewFs = join(REPO_ROOT, entityFile.preview_image_path.split("/").join(sep));
          zip.addFile(entityFile.preview_image_path, readFileSync(previewFs));
        }
      }
      if (e.type === "agent") {
        // Ship the agent's V2 repo tree: every file sitting alongside the
        // entity JSON in its directory (skills/tools/prompt files). The
        // install handler reads them as the new agent's repo contents.
        for (const sibling of entityDirSiblings(e.path)) {
          zip.addFile(sibling.archivePath, readFileSync(sibling.abs));
        }
      }
    }
  }

  return zip;
}

// ----------------------------------------------------------------------------
// Main.
// ----------------------------------------------------------------------------
const manifest = readJson(MANIFEST_FILE);

const appEntities = (manifest.entities ?? []).filter((e) => e.type === "app");
if (appEntities.length === 0) {
  info("no app entities — skipping app build step");
} else {
  for (const e of appEntities) {
    const entityFs = join(REPO_ROOT, e.path.split("/").join(sep));
    if (!existsSync(entityFs)) {
      fail(`app ${e.key}: entity file ${e.path} not found`);
    }
    const entityFile = readJson(entityFs);
    if (entityFile.bundle_path) buildApp(e, entityFile);
  }
}

validateManifest(manifest);
ok(`manifest validated`);

if (dryRun) {
  ok("dry run — skipping zip");
  process.exit(0);
}

mkdirSync(DIST_DIR, { recursive: true });
const slugSegment = manifest.slug.split("/")[1];
const outPath = join(DIST_DIR, `${slugSegment}-${manifest.version}.zip`);
const zip = buildPluginZip(manifest);
zip.writeZip(outPath);

const size = statSync(outPath).size;
console.log("");
ok(
  `${manifest.slug} v${manifest.version} · ${manifest.entities.length} entities · ${size.toLocaleString()} bytes → ${relative(REPO_ROOT, outPath)}`,
);
