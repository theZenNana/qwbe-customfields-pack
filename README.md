# customfields-pack — extra fields for any cube, defined at runtime

Restored 2026-08-30 from the ZRHive backup (`qwbe-packs/store/customfields-pack`) — the owner
said the move out was a mistake. Ported to the current public cube contract the same way
crm-pack's contacts cube was ported on QWB-30: `defineCube` from `qwbe-core/cube`, imports
only `qwbe-core/*` public subpaths. Behaviour unchanged: same tables (`customfield_defs`,
`customfield_values`), same entity (`CustomField`), same permissions (`customfields:read`,
`customfields:write`, `customfields:values`), same events.

## Design, in two sentences

Values live HERE (side tables keyed by `cube:rowId`), not in the target row — a key the target
cube does not declare is silently dropped by its schema, so writing there loses data. The cost:
no sorting/filtering on custom values, one extra request per detail screen. Definition owns the
validation: text/number/date/bool/select, strict from the first version.

## What is NOT restored (yet)

The old web screens (`qwbe-packs/web/CustomFields.tsx`, `web/customfields/`) are NOT brought
back: the current `qwbe/web` is a different app with no per-cube UI composition point — that is
the known kernel gap recorded in the 2026-08-29 research (`crm-pack/research/
2026-08-29-customfields-cub-de-sistem.md`). The probes (`probes/customfields*.mjs`) also stay
in the backup until someone ports them.

## Commands

    npm install        # qwbe-core is a file: link into the qwbe repo
    npm test           # source boundary gate
    npm run typecheck

After cloning: `git config core.hooksPath .githooks` (gitleaks pre-commit, same as crm-pack).

## Install

Via the qwbe /install page: scan a parent directory (this repo), tick `customfields-pack`,
install, restart the API. Requires a qwbe checkout with the install-scan feature
(`feature/install-scan-select` or later main).
