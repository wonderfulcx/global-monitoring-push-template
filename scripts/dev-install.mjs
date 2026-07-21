#!/usr/bin/env node
// scripts/dev-install.mjs — package the plugin (unless told otherwise) and
// install it straight onto a tenant through the controller's dev-install
// endpoint, skipping the catalog admin SPA + review flow. Polls the install
// job until it settles and prints the resulting apps.
//
//   pnpm dev-install                       # package + install dist/<slug>-<version>.zip
//   pnpm dev-install -- --no-package       # reuse the existing zip
//   pnpm dev-install -- dist/foo-1.2.3.zip # install a specific zip
//
// Configuration (flag > environment > .env file at the repo root > default):
//   --key KEY         WONDERFUL_API_KEY                 (required)
//   --base URL        WONDERFUL_BASE_URL                (default http://localhost:5050)
//   --workspace UUID  WONDERFUL_TARGET_WORKSPACE_ID     (default all-zeros = General)
//   --timeout SECS    poll timeout                      (default 120)
//
// Constraints inherited from the platform:
//   - The uploaded zip must be under 64 MiB (controller MaxDevInstallArchiveBytes).
//   - Agent-asset plugins (skill/tool entities) can NOT be dev-installed: the
//     HTTP handler never populates target_agent_id, so the install pipeline
//     hard-errors. Use the JSON install endpoints (install / install-on-agents)
//     for those. This script fails fast with that explanation.
//   - After every dev-install the plugin's apps are dropped and recreated:
//     app IDs change and permissions reset to "restricted".

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
const MAX_DEV_INSTALL_ARCHIVE_BYTES = 64 * 1024 * 1024;

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}
function info(message) { console.log(`· ${message}`); }
function ok(message) { console.log(`✓ ${message}`); }
function warn(message) { console.log(`⚠ ${message}`); }

// --- config -----------------------------------------------------------------

function readDotEnv() {
  const envPath = join(REPO_ROOT, ".env");
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}
const flagKey = flagValue("--key");
const flagBase = flagValue("--base");
const flagWorkspace = flagValue("--workspace");
const flagTimeout = flagValue("--timeout");
const noPackage = args.includes("--no-package");
const positional = args.filter((a) => !a.startsWith("--"));

const dotEnv = readDotEnv();
const cfg = (flag, name, fallback) => flag ?? process.env[name] ?? dotEnv[name] ?? fallback;
const apiKey = cfg(flagKey, "WONDERFUL_API_KEY");
const baseUrl = cfg(flagBase, "WONDERFUL_BASE_URL", "http://localhost:5050").replace(/\/$/, "");
const workspaceId = cfg(flagWorkspace, "WONDERFUL_TARGET_WORKSPACE_ID", GENERAL_WORKSPACE_ID);
const timeoutSeconds = Number(cfg(flagTimeout, "WONDERFUL_DEV_INSTALL_TIMEOUT", "120"));

if (!apiKey) {
  fail(
    "no API key — pass --key, set WONDERFUL_API_KEY in the environment, or add " +
      "WONDERFUL_API_KEY=… to a .env file at the repo root",
  );
}

// --- package + locate the zip ------------------------------------------------

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "manifest.json"), "utf8"));

const agentAssetEntities = (manifest.entities ?? []).filter(
  (e) => e.type === "skill" || e.type === "tool",
);
if (agentAssetEntities.length > 0) {
  fail(
    `this plugin declares agent-asset entities (${agentAssetEntities
      .map((e) => `${e.key}:${e.type}`)
      .join(", ")}) — dev-install cannot install skill/tool plugins because the ` +
      `endpoint carries no target_agent_id. Install through the catalog install ` +
      `endpoints (POST …/install with target_agent_id, or …/install-on-agents) instead.`,
  );
}

let zipPath;
if (positional.length > 0) {
  zipPath = resolve(REPO_ROOT, positional[0]);
} else {
  if (!noPackage) {
    info("packaging (node scripts/package.mjs)…");
    const pkg = spawnSync("node", [join(REPO_ROOT, "scripts", "package.mjs")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (pkg.status !== 0) fail(`package step exited with ${pkg.status}`);
  }
  zipPath = join(REPO_ROOT, "dist", `${manifest.slug.split("/")[1]}-${manifest.version}.zip`);
}
if (!existsSync(zipPath)) fail(`zip not found: ${zipPath}`);

const zipBytes = readFileSync(zipPath);
if (zipBytes.length > MAX_DEV_INSTALL_ARCHIVE_BYTES) {
  fail(
    `${zipPath} is ${zipBytes.length.toLocaleString()} bytes — dev-install rejects ` +
      `archives over ${MAX_DEV_INSTALL_ARCHIVE_BYTES.toLocaleString()} bytes (64 MiB)`,
  );
}

// --- upload -------------------------------------------------------------------

async function api(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const detail = typeof body === "object" ? JSON.stringify(body) : String(body).slice(0, 500);
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${detail}`);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const form = new FormData();
form.append("file", new Blob([zipBytes], { type: "application/zip" }), zipPath.split("/").pop());
form.append("target_workspace_id", workspaceId);

info(`dev-installing ${manifest.slug} v${manifest.version} → ${baseUrl} (workspace ${workspaceId})`);
let install;
try {
  install = (await api("/api/v1/catalog/plugins/dev-install", { method: "POST", body: form })).data;
} catch (err) {
  fail(err.message);
}
ok(`install job ${install.job_id} accepted (status ${install.status})`);

// --- poll ----------------------------------------------------------------------

const TERMINAL_OK = new Set(["installed", "dev"]);
const TERMINAL_FAIL = new Set(["failed", "update_failed"]);
const deadline = Date.now() + timeoutSeconds * 1000;
let row = install;
while (!TERMINAL_OK.has(row.status) && !TERMINAL_FAIL.has(row.status)) {
  if (Date.now() > deadline) {
    fail(`install ${install.job_id} still ${row.status}/${row.phase} after ${timeoutSeconds}s`);
  }
  await sleep(2000);
  try {
    row = (await api(`/api/v1/catalog/installs/${install.job_id}`)).data;
  } catch (err) {
    fail(err.message);
  }
}
if (TERMINAL_FAIL.has(row.status)) {
  fail(
    `install ${row.status} (phase ${row.phase})` +
      (row.last_error ? `: ${row.last_error}` : " — check the controller logs for details"),
  );
}
ok(`installed v${row.installed_version} (status ${row.status}, phase ${row.phase})`);

// --- report the resulting apps ---------------------------------------------------

const appEntityNames = (manifest.entities ?? [])
  .filter((e) => e.type === "app")
  .map((e) => {
    try {
      const file = JSON.parse(
        readFileSync(join(REPO_ROOT, ...e.path.split("/")), "utf8"),
      );
      return file.name ?? e.key;
    } catch {
      return e.key;
    }
  });
if (appEntityNames.length > 0) {
  const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const wanted = new Set(appEntityNames.map(slugify));
  try {
    const apps = (await api("/api/v2/apps")).data ?? [];
    const mine = apps.filter((a) => wanted.has(slugify(a.slug ?? "")) || wanted.has(slugify(a.name ?? "")));
    for (const a of mine) {
      ok(`app ${a.name} → id ${a.id} · slug ${a.slug} · permissions ${a.permissions}`);
    }
    warn(
      "dev-install recreates apps: IDs above are NEW and permissions reset to " +
        '"restricted" — re-grant public access if the app needs it.',
    );
  } catch (err) {
    warn(`installed, but listing apps failed: ${err.message}`);
  }
}
