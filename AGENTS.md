## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues; use the `gh` CLI to create, read, and update them. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Releases (npm)

- **Trigger**: pushing a `v*` tag runs `.github/workflows/publish.yml` (Trusted Publisher / OIDC, zero token).
- **Who does what**: bumping `version` in `package.json` and tagging is the executing agent's job; pushing requires fresh per-turn user confirmation (see §2 Security & Authorization).
- **Gate**: direct flow — CI runs `npm publish --provenance`; a `v*` tag push releases immediately, no human 2FA gate. Prereq: the Trusted Publisher Allowed actions on npmjs.com must permit `npm publish` (stage-only would 403).
- **First release exception**: OIDC cannot create a package that does not exist yet (the Trusted Publisher binding requires an existing package) — the first publish must be a local `npm publish` (login + 2FA) by the maintainer, then bind the Trusted Publisher on npmjs.com.
- **Rollback**: `npm unpublish <version>` within 72h (needs local login); after that `npm deprecate`.
- **Tag signing**: release tags are **always signed** (`tag.gpgsign=true`, SSH signing key). Do **not** bypass with `git -c tag.gpgsign=false` — never degrade a release tag to unsigned (historical pre-0.10.0 tags are unsigned legacy only, new tags never). An agent creates tags with a plain `git tag -a vX.Y.Z -m ...`; if signing fails (ssh-agent locked / passphrase needed), stop and hand back to the maintainer — no workaround.
- **Release notes**: the executing agent writes categorized release notes (per the npm-release skill's guide) and creates the GitHub Release after the publish succeeds; the workflow builds no placeholder Release.
