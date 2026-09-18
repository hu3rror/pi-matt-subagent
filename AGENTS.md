## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues; use the `gh` CLI to create, read, and update them. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Releases (npm)

- **Trigger**: pushing a `v*` tag runs `.github/workflows/publish.yml` (Trusted Publisher / OIDC, zero token).
- **Who does what**: bumping `version` in `package.json` and tagging is the executing agent's job; pushing requires fresh per-turn user confirmation (see §2 Security & Authorization).
- **Gate**: Mode A (staged) — CI runs `npm stage publish --provenance`; the actual publish happens only after the maintainer runs `npm stage approve <stage-id>` locally with 2FA.
- **First release exception**: OIDC and `npm stage` cannot create a package that does not exist yet — the first publish must be a local `npm publish` (login + 2FA) by the maintainer, then bind the Trusted Publisher on npmjs.com.
- **Rollback**: a wrong staging is cleared with `npm stage reject <stage-id>`.
- **Tag signing**: with `tag.gpgsign=true`, an agent cannot enter the passphrase — use `git -c tag.gpgsign=false tag -a vX.Y.Z -m ...` to stay consistent.
- **Release notes**: the executing agent writes categorized release notes (per the npm-release skill's guide) and creates the GitHub Release after the maintainer approves the stage; the workflow builds no placeholder Release (Mode A).
