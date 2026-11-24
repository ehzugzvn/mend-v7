# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ehzugzvn/mend-v7/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ehzugzvn/mend-v7/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies an edit written by an AI model to a tree of
text files. Models write edits in four formats — unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and mend reads each one exactly as `SPEC.md` says, matching old lines at three
tiers (exact, trailing-whitespace-insensitive, and indentation-insensitive) so drifted
edits still land. Every file is changed or nothing is: if any edit fails, all failures
are reported and no file is written.

## Running it

Requires Node 22; there are no dependencies (standard library only).

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory, which is the root of
  the tree. When `PATCH` is absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or `json`.
  The default, `auto`, detects the format from the patch text.
- `--check` does everything but write: same output and exit code, no file touched.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one line per changed path (`A`, `D`, `M`, or `R old -> new`
for a move) in byte order, then `ok: <n> files`, and exits 0. When edits fail it
prints one `error: <code> <path>` line per failed edit, then `failed: <k> of <n>
edits`, and exits 1. Usage errors, unreadable patch files, undetectable formats and
parse errors print a single `error: ...` line and exit 2.

## Layout

- `main.ts` — the whole tool, built around two dispatch tables: `FORMAT_PARSERS`
  maps each format name to the function that turns patch lines into tagged edit
  records (`{ kind, ... }`), and `APPLY` maps each edit kind to the function that
  carries it out against an in-memory file tree. Shared helpers — the three-tier
  line matcher, the file tree, and path safety — sit behind the tables, so no
  format or edit kind is routed by a long chain of if/else branches.
- `SPEC.md` — the full specification mend implements.
- `runner.ts` / `check.ts` — the kit's trial runner and practice checker:

      node check.ts <practice.json>

## License

MIT — see `LICENSE`.
