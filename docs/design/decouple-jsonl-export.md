# Design: Decouple writes from JSONL export (P2 #7, option a)

Status: **proposal** — not yet implemented. Direction chosen by the maintainer.
Author: handoff design for the next implementation pass.

## TL;DR

Today every entity write (CLI or MCP) does `SQLite mutation → full-snapshot
`exportToJSONL` → markdown`. In a shared (git-common) store, that means the
git-tracked JSONL is continuously rewritten from the *entire* live DB — including
other agents' in-flight rows and throwaway/test writes. You cannot stage or
commit a subset; someone else's write drags your uncommitted state into the git
artifact.

**Proposal:** make SQLite the live runtime truth and JSONL an explicit,
git-boundary artifact. Stop auto-exporting on every write (gated by an
`autoExport` config, default preserving today's behavior for solo users), and
materialize JSONL at commit time via an installed `pre-commit` hook. The pull
side is already handled by the new `sync` MCP verb (`import`).

## Current model (as-built, verified)

- **Store resolution** (`cli/src/store-resolution.ts`): tiers to a git-common-dir
  store when one exists, else legacy per-worktree `.sudocode/`. `storeDir` holds
  **both** `cache.db` and `specs.jsonl`/`issues.jsonl` (colocated). So with a
  shared store, the JSONL is a **single shared copy**, not per-worktree.
- **Every CLI write handler** (~14 sites across issue/spec/feedback/reference/
  relationship/sync commands) calls `exportToJSONL(ctx.db, {outputDir})` after
  the mutation. `exportToJSONL` writes the **whole** DB snapshot, serialized
  through `withExportLock` (`cli/src/file-lock.ts`, O_EXCL lockfile — this
  already prevents *concurrent-export corruption*, a different problem).
- **Issues also write markdown** per-write (9 sites, `syncJSONLToMarkdown` /
  `syncFileWithRename`). Markdown is per-entity, so it does **not** drag other
  rows.
- **Server** (`server/`) reads its own SQLite handle (`project-manager.ts`),
  exports via its own service, imports on demand. **Frontend** talks to the
  server. → Neither the server nor the UI depends on JSONL freshness.
- **Git hooks are already installed by sudocode** (`cli/src/backup.ts` installs a
  `pre-push` backup hook into the git-common hooks dir). The machinery to install
  a `pre-commit` hook already exists and is idiomatic here.

## The problem (P2 #7)

Auto-export couples the **git artifact** to **every runtime mutation**:

1. A concurrent session's write triggers a full export that serializes *your*
   in-flight rows into the shared, git-tracked JSONL before you intended.
2. Scratch/test writes leak into git-tracked JSONL immediately; there is no
   "runtime state I haven't decided to persist yet."
3. You cannot stage a subset — `git add issues.jsonl` always captures the full
   current DB, i.e. everyone's WIP.

The export **lock** fixed atomicity (no dropped rows across racing exports). It
did **not** decouple runtime state from the git artifact, which is what remains.

## Proposed design (option a)

### 1. Gate auto-export behind config, routed through one helper

Replace the ~14 direct `exportToJSONL(ctx.db, {outputDir})` calls with a single
`maybeAutoExport(ctx)` helper:

```ts
// cli/src/export.ts (or a small sync helper module)
export async function maybeAutoExport(ctx: CommandContext): Promise<void> {
  if (getEffectiveConfig(ctx).autoExport === false) return;
  await exportToJSONL(ctx.db, { outputDir: ctx.outputDir });
}
```

- New project config key `autoExport` (project-level, git-tracked): default
  **true** (today's behavior — solo users unaffected). Multi-agent setups set it
  `false`.
- Centralizing means the toggle lives in one place and the 14 sites become
  one-line swaps.

### 2. Materialize JSONL at the git boundary via an installed pre-commit hook

Reuse the `backup.ts` hook-install pattern to install a `pre-commit` hook into
the git-common hooks dir:

```sh
# .git/hooks/pre-commit (managed block)
sudocode export --quiet            # refresh JSONL from the live DB
git add -- "$SUDOCODE_STORE"/specs.jsonl "$SUDOCODE_STORE"/issues.jsonl
```

Result: **runtime writes touch SQLite only** (fast, no JSONL churn, no
cross-agent leak); **every commit still contains fresh, complete JSONL**; JSONL
is never stale *in git*, only in the working tree between commits — which is
fine, because SQLite is the runtime truth.

- `sudocode export` already exists (`cli.ts` `export` command). Add `--quiet`.
- Install the hook on `init` (and expose `sudocode hooks install` for existing
  repos), guarded by a managed-block marker so we never clobber a user hook.

### 3. Pull side — already done

`git pull` brings new JSONL; `import` rebuilds the cache. The **`sync` MCP verb**
(shipped) and `sudocode import` cover this. Optionally add a `post-merge` hook
that runs `sudocode import` so pulls auto-refresh the cache.

### 4. Markdown — leave live

Markdown writes are per-entity and don't drag other rows, so they don't have the
split-brain problem. Keep them synchronous. (If `sourceOfTruth=markdown`, the
watcher already drives markdown→DB; export still only affects JSONL.)

## Migration & compatibility

- **Default `autoExport: true`** ⇒ zero behavior change for existing solo repos
  and existing tests. The decoupled workflow is strictly opt-in per project.
- **Tests that write-then-read JSONL**: unaffected while default is true. New
  tests for the decoupled path set `autoExport: false` and call `export`
  explicitly (or assert the hook path).
- **Server** already manages its own export/import; no change required, but it
  should also honor `autoExport` for parity if it writes on behalf of agents.
- **Existing repos** opt in via `sudocode config set autoExport false` +
  `sudocode hooks install`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| User commits without the hook (JSONL stale in git) | Hook installed on init; `sync`/`status` warns if DB is ahead of JSONL (compare max `updated_at`). |
| Hook clobbers a user's existing pre-commit | Managed-block markers; append, never overwrite; `hooks install` is idempotent. |
| A fresh clone / new machine only has JSONL, DB is behind | `import` on first run (already the model); post-merge hook makes it automatic. |
| Someone relies on JSONL updating live in the working tree | That's the behavior we're intentionally changing; `autoExport: true` preserves it. |

## Optimistic-concurrency token (fold in here)

Deferred from the P2 additive pass; belongs with this redesign because it also
touches the write path. Add optional `expected_updated_at` to `upsert_issue`/
`upsert_spec` update; `updateIssue`/`updateSpec` reject with a structured
`STALE_WRITE` error when the row's current `updated_at` differs. With SQLite as
the shared truth, this catches "two agents edited the same row" cleanly. Small,
localized once the write path is being touched anyway.

## Task breakdown (rough)

1. `autoExport` config key + `maybeAutoExport` helper; swap ~14 call sites. (S)
2. `sudocode export --quiet`; `sudocode hooks install` + init wiring, reusing
   `backup.ts` patterns; managed-block pre-commit (and optional post-merge). (M)
3. Staleness warning in `sync`/`status` (DB ahead of JSONL). (S)
4. Optimistic-concurrency `expected_updated_at` + `STALE_WRITE`. (S–M)
5. Tests: decoupled write path, hook export, stale-write rejection. (M)

## Open decisions for the maintainer

1. **Default of `autoExport`** — true (safe, opt-in decoupling) vs false (decouple
   everyone, more breakage but the "correct" end state). Recommendation: ship
   true, flip to false in a later major once hooks are proven.
2. **Post-merge auto-import hook** — install by default, or leave pulls to the
   explicit `sync` verb? Recommendation: install it; it's the symmetric half.
3. **Server parity** — should the local server honor `autoExport` too, or keep
   exporting (it's a single writer)? Recommendation: honor it for consistency.
