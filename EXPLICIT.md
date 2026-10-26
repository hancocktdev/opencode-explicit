# opencode explicit

`explicit` is a branch of this fork of [opencode](https://github.com/anomalyco/opencode) (v2) that
removes or switches off anything that runs, downloads or loads code without being chosen.

- **Based on:** upstream `dev` at commit
  [`b64cc80db3c933c7a83980b1f36eef047551c845`](https://github.com/anomalyco/opencode/commit/b64cc80db3c933c7a83980b1f36eef047551c845)
  (upstream's own commit, 2026-10-24: "fix(core): wait for plugin activation before each runner step (#51133)").
  Every commit after it on this branch is one of this branch's changes.
- **Never synced automatically.** Upstream changes are not pulled in as a matter of course. The branch is
  rebased onto a newer upstream commit only after reviewing that upstream change, and only when there is a
  deliberate reason or a real need for it.

The rules behind every change:

- **Nothing runs, installs, updates or loads unless it was explicitly configured.**
- **No approval is ever stored as a standing default.** Approving something answers that one request,
  or at most the rest of that session. It is never saved, so every new session asks again.

## What explicit changes

| Area | Upstream v2 | explicit |
|---|---|---|
| Plugins | Loads plugins found in `.opencode/plugin(s)/` folders and installs plugins listed in config | Loads only plugins explicitly listed in the global config; never installs anything from npm on its own |
| Project config | A project's `opencode.json(c)` and `.opencode/` can change any setting | A project may only set `snapshots`; everything else comes from the user's global config |
| Formatters | Installs npm formatters (prettier, biome, oxfmt) into the cache when a project lists them | Never installs; uses only formatters already on `PATH` |
| Console MCP | Adds the hosted Console MCP server | Not added |
| Local model providers | Probes localhost ports for local model servers at startup | No probing unless configured |
| Outside-folder access | Every agent may read and write outside the session folder; an approval covers the file's whole parent tree, or the whole repository it sits in (`*` matches at any depth), writes included | Every agent, including Explore, asks first (`external_directory: ask`, v1's old default). A request names exactly the file (a searched folder stays `<dir>/*`), and says whether it reads or writes; approving a read never approves a write. An extra answer, **Allow folder (read)**, approves reads anywhere under that folder for the rest of the session only; it never approves writes or other actions, and never `/` |
| Config discovery | Walks every parent folder up to `/` | Stops at `$HOME` |
| ripgrep | Downloads a prebuilt `rg` with no checksum check if none is on `PATH` | Never downloads; fails with an install hint instead |
| Updates | Checks for and installs updates in the background | Never checks; updating means rebuilding this branch |
| `.claude` / `.agents` skills | Loaded by default | Loaded only with `OPENCODE_ENABLE_CLAUDE_CODE=1` |
| Skill folders | A skill path is scanned up to 6 levels deep (following symlinks, plus top-level `.md` files); URLs are downloaded; the config folder's `skill/` and `skills/` are scanned and watched | A skill path is exactly one skill (`<folder>/SKILL.md`); URLs are never fetched; config folders are not skill sources |
| Tool visibility | `worktree_remove` stays visible even when `opencode_*` is denied | Hidden along with the other opencode tools; deleting a worktree still asks |
| "Always allow" | Saved per project with no expiry, as the tool's broad pattern (often `*`, or a command prefix + `*`): one approval applies to every later session in that folder | Renamed **Allow for session**: covers exactly the items listed in the prompt (compared literally) for the rest of that session (and its subagents) only, is never saved, and the next session asks again. Approvals saved by upstream builds are ignored |

Each change is its own commit, and each behaviour has a test that fails if the change is reverted
(`packages/core/test/explicit.test.ts`, `explicit-permission.test.ts` and `explicit-file-access.test.ts`; the update check
can't be unit-tested and was checked by running the build). Upstream tests that assert the old
behaviour are expected to fail on this branch.

## Native dependency review

The single-file Linux x64 build ships these native and WASM components. Each was reviewed at the
version locked on this branch: source provenance against the published npm package, what it can
reach (network, processes, files), and published security advisories.

| Package | Version | Role | Verdict (2026-10-26) |
|---|---|---|---|
| `@opencode-ai/pty-linux-x64-gnu` | 0.3.1 | Persistent-terminal daemon | Local Unix socket only; no advisories |
| `@opentui/core-linux-x64` | 0.6.8 | TUI rendering | No network beyond a localhost-only X11 clipboard path; no advisories |
| `@ff-labs/fff-bin-linux-x64-gnu` | 0.10.5 | File-name search index | No network or processes; no advisories. Bundled `bincode` 1.3.3 is unmaintained (RUSTSEC-2025-0141, not a flaw); other Rust advisories in its lockfile affect crates not compiled into the shipped library |
| `@parcel/watcher-linux-x64-glibc` | 2.5.1 | File watching | inotify backend only (Watchman never used); no advisories |
| `@silvia-odwyer/photon-node` | 0.3.4 | Image processing (WASM) | WASM imports reach no network, processes or files; no advisories |
| `web-tree-sitter` | 0.25.10 | Parser runtime (WASM) | No file-open import; browser-only fetch paths unused; no advisories |
| `tree-sitter-bash` | 0.25.0 | Shell command parsing (WASM) | Grammar only; no advisories |
| `tree-sitter-powershell` | 0.25.10 | PowerShell parsing (WASM) | Grammar only; no advisories |

Not yet done: rebuilding each artefact from source and comparing it with the published one.

## Building

From `packages/cli`:

```sh
OPENCODE_CHANNEL=v2 OPENCODE_VERSION=<upstream version>-explicit bun run build --single --skip-install --skip-web-ui
```

- `OPENCODE_CHANNEL=v2` keeps this build's database and service files separate from any official install.
- Give a real version number: the opencode free tier refuses `0.0.0-…` builds.
- `--skip-install` leaves the lockfile alone and downloads no other platforms' binaries.
- Have `rg` on `PATH` before running the build (this branch never downloads it).
