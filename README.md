# customfields-pack — extra fields for any cube, defined at runtime

Restored 2026-08-30 from the ZRHive backup (`qwbe-packs/store/customfields-pack`), then ported
to the QWB-46 contract the same day: definitions in this cube's own table, VALUES in the target
row itself. Imports only `qwbe-core/*` public subpaths, `defineCube` from `qwbe-core/cube`.

## Where values live now (QWB-46)

In the TARGET ROW's own body, under the reserved `custom` sub-object. The kernel folds every key
a cube's static payload schema does not declare into `body.custom` and keeps it there in jsonb
(ADR-0001 sections 3–4: jsonb + GIN index) — so:

    POST /crm/contacts {"name":"Test","cnp":"123"}   -> 200, row body carries custom.cnp
    GET  /crm/contacts/<id>                          -> the row, `custom` included

The values are written and read through the target cube's own API and store — no sidecar table,
no extra request per detail screen, and the values are queryable like any other jsonb key.

This cube now owns:

- DEFINITIONS (`customfield_defs`): name, target cube, type, options, required, position.
- VALIDATION, strict from the first version: text/number/date/bool/select. The PUT
  `/customfields/values` endpoint VALIDATES ONLY — it stores nothing (the response is the
  validated field list, not a confirmation); the save happens through the target cube's API.
- THE ORPHAN REPORT: deleting a definition never deletes values. They stay in the rows and are
  reported as orphans — `GET /customfields/orphans?cube=<cube>` or the
  `customfields:orphans <cube>` command (admin gate, `customfields:write`).
- METADATA: `providesCustomFields: true` makes the kernel publish the active definitions in the
  target cube's `/catalog/<cube>/metadata`, marked `custom: true`, so a frontend can tell them
  apart from static fields.

## What changed from the pre-QWB-46 restore

- The `customfield_values` sidecar table is gone (fresh installs; an old copy of the table is
  simply no longer read or written).
- The values lookup reads the target row; the values write is a validation pre-flight.
- Permissions are `customfields:read` and `customfields:write`; the separate
  `customfields:values` gate is gone because this cube no longer writes values at all.
- The web panel in the current `qwbe/web` still calls the old save path — that half is QWB-52.

## Commands

    npm install        # qwbe-core is a file: link into a qwbe checkout's core/
    npm test           # source boundary gate + unit tests (validation, orphans)
    npm run typecheck

After cloning: `git config core.hooksPath .githooks` (gitleaks pre-commit, same as crm-pack).

## Install

Via the qwbe /install page: scan a parent directory (this repo), tick `customfields-pack`,
install, restart the API. The target cube (e.g. `crm-pack`'s `crm/contacts`) must be mounted:
a definition naming an unmounted cube is refused with a clear message.
