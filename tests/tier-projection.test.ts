// Drift guard: everything the shared core reads must be projected by applyTier.
//
// THE BUG THIS EXISTS TO CATCH. `applyTier` decides what leaves the tenant by
// naming each field explicitly — which is correct for a data boundary (an
// allowlist, never a denylist) but means it silently DROPS any field the core
// starts returning. The failure is invisible from both ends: the cron pays for
// the extra reads and reports a clean green run, the hub receives a snapshot
// that simply lacks the field, and nothing anywhere errors. That is the exact
// shape of the pending tech-ops work: core gains service health, per-agent
// latency, tag counts and detector verdicts, and none of it arrives.
//
// So this test reads BOTH files off disk — the pinned shared_lib/core.ts that
// is actually inlined at package time, and the cron's applyTier — and asserts
// the two key sets agree. Source-level rather than by import, because neither
// file may use `export`: they are concatenated into one runtime source string
// (see core.ts's header). Adding a field to core and nothing else turns this
// red with the field's name in the message.
//
// A field may be deliberately withheld at every tier — add it to WITHHELD_BY_
// DESIGN with a reason. That keeps "we chose not to send this" distinguishable
// from "we forgot", which is the whole point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = resolve(HERE, "../shared_lib/core.ts");
const CRON_PATH = resolve(HERE, "../entities/monitoring-push.cronjob/code.ts");

// Fields core returns that applyTier intentionally never forwards under its own
// name. Each needs a reason, not just an entry.
const WITHHELD_BY_DESIGN = new Map<string, string>([
  [
    "error",
    "applyTier folds a scalar `error` into the `errors` array (its trailing else-if), so it has no `out.error` of its own.",
  ],
]);

/** Byte offset just past the opening brace of `fn`'s body, plus its end. */
function functionBody(source: string, path: string, fnName: string): string {
  const sig = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(source);
  if (!sig) throw new Error(`tier-projection: no "function ${fnName}(" in ${path}`);
  const open = source.indexOf("{", sig.index);
  if (open === -1) throw new Error(`tier-projection: no body for ${fnName} in ${path}`);
  return source.slice(open, matchBrace(source, open, path, fnName) + 1);
}

/** Index of the `}` closing the `{` at `open`, skipping strings and comments. */
function matchBrace(source: string, open: number, path: string, what: string): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    i = skipInert(source, i);
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  throw new Error(`tier-projection: unbalanced braces in ${what} (${path})`);
}

/**
 * If `i` starts a string, template or comment, returns the index of its final
 * character so the caller's loop steps past it. Otherwise returns `i`.
 */
function skipInert(source: string, i: number): number {
  const ch = source[i];
  if (ch === "/" && source[i + 1] === "/") {
    const nl = source.indexOf("\n", i);
    return nl === -1 ? source.length - 1 : nl;
  }
  if (ch === "/" && source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length - 1 : end + 1;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    for (let j = i + 1; j < source.length; j++) {
      if (source[j] === "\\") j++;
      else if (source[j] === ch) return j;
    }
    throw new Error("tier-projection: unterminated string literal");
  }
  return i;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

/**
 * Top-level keys of an object literal (text including its outer braces).
 *
 * Tracks key-vs-value position so `alerts: alertDetails` yields `alerts` and
 * not `alertDetails`, and descends into `...(cond ? { k } : {})` spreads. A
 * spread it cannot read is a hard error — silently missing a key would defeat
 * the guard.
 */
function objectLiteralKeys(literal: string, what: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let expectKey = true;

  for (let i = 0; i < literal.length; i++) {
    const skipped = skipInert(literal, i);
    if (skipped !== i) {
      // A quoted key ("foo": …) is the one inert region that carries a key.
      if (depth === 1 && expectKey && /["'`]/.test(literal[i])) {
        const raw = literal.slice(i + 1, skipped);
        if (raw) keys.add(raw);
        expectKey = false;
      }
      i = skipped;
      continue;
    }

    const ch = literal[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;

    if (ch === ":") {
      expectKey = false;
      continue;
    }
    if (ch === ",") {
      expectKey = true;
      continue;
    }
    if (ch === "." && literal.startsWith("...", i)) {
      const spread = spreadExpression(literal, i + 3, what);
      for (const k of spreadKeys(spread, what)) keys.add(k);
      i = spread.end;
      expectKey = false;
      continue;
    }
    if (expectKey && IDENT_START.test(ch)) {
      let j = i;
      while (j < literal.length && IDENT.test(literal[j])) j++;
      keys.add(literal.slice(i, j));
      i = j - 1;
      expectKey = false;
    }
  }
  return keys;
}

/** The balanced expression a `...` spread applies to. */
function spreadExpression(literal: string, from: number, what: string): { text: string; end: number } {
  let depth = 0;
  for (let i = from; i < literal.length; i++) {
    i = skipInert(literal, i);
    const ch = literal[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return { text: literal.slice(from, i), end: i - 1 };
      depth--;
    } else if (ch === "," && depth === 0) return { text: literal.slice(from, i), end: i - 1 };
  }
  throw new Error(`tier-projection: could not find the end of a spread in ${what}`);
}

/** Keys contributed by a spread — read from the object literals inside it. */
function spreadKeys(spread: { text: string }, what: string): string[] {
  const found = [...spread.text.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*(?::|,|\})/g)].map((m) => m[1]);
  if (found.length === 0) {
    throw new Error(
      `tier-projection: cannot tell which keys "...${spread.text.trim()}" contributes in ${what}. ` +
        `Teach this test to read it — do not let it pass unread.`,
    );
  }
  return found;
}

/** Every key any `return { … }` inside `fnBody` produces. */
function returnedKeys(fnBody: string, what: string): Set<string> {
  const keys = new Set<string>();
  let found = 0;
  for (const m of fnBody.matchAll(/return\s*\{/g)) {
    const open = fnBody.indexOf("{", m.index);
    const literal = fnBody.slice(open, matchBrace(fnBody, open, what, "a return literal") + 1);
    for (const k of objectLiteralKeys(literal, what)) keys.add(k);
    found++;
  }
  assert.ok(found > 0, `tier-projection: found no object return in ${what}`);
  return keys;
}

/** Keys applyTier writes: its `out` initializer plus every `out.x =`. */
function projectedKeys(cronSource: string): Set<string> {
  const body = functionBody(cronSource, CRON_PATH, "applyTier");
  const init = /const\s+out\s*:[^=]*=\s*\{/.exec(body);
  assert.ok(init, "tier-projection: applyTier no longer initialises `out` with an object literal");
  const open = body.indexOf("{", init.index + init[0].length - 1);
  const keys = objectLiteralKeys(body.slice(open, matchBrace(body, open, CRON_PATH, "applyTier out") + 1), "applyTier");
  for (const m of body.matchAll(/\bout\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);
  return keys;
}

const core = readFileSync(CORE_PATH, "utf8");
const cron = readFileSync(CRON_PATH, "utf8");
const returned = returnedKeys(functionBody(core, CORE_PATH, "fetchTenantStatus"), "fetchTenantStatus");
const projected = projectedKeys(cron);

test("applyTier projects every field fetchTenantStatus returns", () => {
  const dropped = [...returned].filter((k) => !projected.has(k) && !WITHHELD_BY_DESIGN.has(k));
  assert.deepEqual(
    dropped,
    [],
    `fetchTenantStatus returns ${dropped.join(", ")}, which applyTier never projects — the field would be ` +
      `collected on the tenant and then silently dropped before the push. Add it to applyTier at the right tier, ` +
      `or to WITHHELD_BY_DESIGN with a reason.`,
  );
});

test("applyTier projects nothing fetchTenantStatus no longer returns", () => {
  // Catches the other half of a rename: the old name lingers in applyTier,
  // projecting undefined, while the new name is caught by the test above.
  const orphans = [...projected].filter((k) => !returned.has(k));
  assert.deepEqual(
    orphans,
    [],
    `applyTier projects ${orphans.join(", ")}, which fetchTenantStatus does not return — stale after a rename, ` +
      `or a field that moved. It currently forwards undefined.`,
  );
});

test("the guard is actually reading both files", () => {
  // Without this, a parser change that quietly returns empty sets would make
  // both tests above pass while checking nothing at all.
  assert.ok(returned.size >= 10, `only ${returned.size} keys parsed from fetchTenantStatus — the parser is not working`);
  assert.ok(projected.size >= 10, `only ${projected.size} keys parsed from applyTier — the parser is not working`);
});
