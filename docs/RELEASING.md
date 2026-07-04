# Releasing

Versioning uses [changesets](https://github.com/changesets/changesets); publishing uses npm **Trusted Publishing** (OIDC from GitHub Actions - no tokens anywhere).

## Day-to-day flow

1. Land changes with a changeset: `bun run changeset` (pick packages + semver bump, describe the change).
2. On push to `main`, `release.yml` opens/updates a **"Version Packages" PR** that applies pending changesets (version bumps + changelogs).
3. Merging that PR triggers `release.yml` again, which runs `changeset publish`: builds, publishes every package whose version is not on npm yet, and pushes `@elisym/<pkg>@<version>` git tags.

The two packages version independently (`fixed: []`, `linked: []`); `@elisym/eval-adapter-solana`'s tilde dependency on `@elisym/eval` is bumped automatically when needed (`updateInternalDependencies: patch`).

## One-time setup (before the first release)

1. **Repo setting**: Settings -> Actions -> General -> enable _"Allow GitHub Actions to create and approve pull requests"_ (the version PR needs it; the workflow already requests `contents: write` + `pull-requests: write`, and `id-token: write` for OIDC).
2. **First publish is manual**: npm Trusted Publishing can only be configured for packages that already exist. From a machine with npm access:
   ```sh
   bun install && bun run build
   cd packages/eval && npm publish --access public
   cd ../eval-adapter-solana && npm publish --access public
   ```
3. **Configure Trusted Publishing on npmjs.com** for both `@elisym/eval` and `@elisym/eval-adapter-solana`: package Settings -> Trusted Publisher -> GitHub Actions, repository `elisymlabs/elisym-eval`, workflow `release.yml`.
4. From then on the workflow publishes via OIDC with `--provenance` (from `publishConfig`), npm >= 11.5.1.

## Note on the elisym monorepo

The main `elisym` monorepo releases with a hand-rolled tag-per-version workflow, not changesets. This repo adopts changesets fresh; if the main monorepo ever migrates, its release.yml can reuse this repo's version-PR + OIDC pattern as-is.

## Live devnet tests

`live.yml` (manual dispatch + weekly cron) runs `turbo run test:live` with secrets `ELISYM_EVAL_DEVNET_PAYER` / `ELISYM_EVAL_DEVNET_PAYEE` (optional `ELISYM_EVAL_RPC_URL`). The suite skips itself with a warning when the keys are missing or the payer wallet holds less than 0.01 SOL - top it up via the devnet faucet.
