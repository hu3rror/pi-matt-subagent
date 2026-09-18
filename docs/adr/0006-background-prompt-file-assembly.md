# Background research assembles prompts into 0600 temp files, never into argv

The blocking subagent path assembled its prompt via a `--append-system-prompt` temp file, while the background `research` path inlined the role prompt into the positional prompt argument — two assembly conventions for the same concern (Spec review item c2). Background assembly is now unified on the blocking path's convention: `buildResearchArgs` emits `--append-system-prompt <prompt.md>` plus a short positional `Task: <task>`, and the role prompt together with the findings path live entirely in files — a 0600 prompt file written into the `pi-research-*` tmpdir, sharing its lifetime with the run log. Nothing role-authored enters argv.

Why files, not argv: the role prompt is third-party-authored (user/project `researcher` roles) and may contain sensitive instructions; argv is visible in the host's process list to any local observer. The 0600 mode keeps the file private to the invoking user, and colocating it with the run log in the tmpdir ties its lifetime to the run so cleanup needs no extra bookkeeping.

## Considered options

- **Inline into the positional prompt (status quo for background)** — one less file, but leaks role content into argv and keeps two divergent assembly paths.
- **Unified `--append-system-prompt` file (chosen)** — one assembly convention across both channels, role content off argv, findings path also file-borne; the only cost is one more temp file, which the log already forces us to create.
- **Pipe the prompt via stdin** — no argv leak, but needs stream plumbing in the runner and breaks the detached-spawn seam the e2e tests rely on.

## Consequences

- Tests had to migrate every call site from inline to file args; one test initially migrated only 1/5 call sites, silently passing `undefined` into argv — caught by the Seam A command-assembly assertions, which now guard the shape of every assembled argv.
- `runBackgroundResearch` owns the tmpdir + file lifecycle; prompt file and run log share it and are cleaned together.
