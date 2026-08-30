// The definition-CRUD half of the customfields handlers (QWB-46: split the file, never raise
// the cap). The values half lives in values.ts.
//
// Definitions are stored HERE, in this cube's own table. Deleting one is a soft delete of the
// DEFINITION ONLY: the values live in the target rows' own bodies, are impossible to touch from
// here by construction, and become orphans that the orphans report surfaces (QWB-46 step 5).

import { Effect } from "effect"
import { requirePermission } from "qwbe-core/auth"
import { BadRequest, NotFound } from "qwbe-core/errors"
import { pageRequest } from "qwbe-core/pagination"
import { CustomFieldCreate, DEFS, ENTITY, type DefRow, NAME } from "./schema.ts"
import { definitionsFor, type PackTools, type Snapshot, refreshSnapshot } from "./context.ts"

export const definitionHandlers = (tools: PackTools, snapshot: Snapshot) => {
  const { store, bus, catalogue } = tools

  return {
    list: ({ urlParams }: { urlParams: { cube?: string | undefined; offset: number; limit: number; sortBy?: string | undefined; descending: boolean } }) =>
      Effect.gen(function* () {
        yield* requirePermission("customfields:read")
        const page = pageRequest(urlParams)
        return yield* urlParams.cube
          ? store.page<DefRow>(DEFS, page, { field: "targetCube", value: urlParams.cube })
          : store.page<DefRow>(DEFS, page)
      }),

    define: ({ payload }: { payload: typeof CustomFieldCreate.Type }) =>
      Effect.gen(function* () {
        yield* requirePermission("customfields:write")
        const p = payload

        if (!NAME.test(p.name)) {
          return yield* Effect.fail(
            new BadRequest({
              message: `name "${p.name}" must match ${NAME} -- a letter, then letters, digits or underscores`,
            }),
          )
        }
        // A field on a cube that is not there would be invisible and unexplained. The
        // catalogue is metadata the kernel hands every cube; nothing is imported to read it.
        // The kernel's catalogue is the authority: a definition for a cube that is not mounted
        // is refused at the door instead of becoming an orphan no one can see (QWB-46 step 4).
        const known = catalogue().map((c) => c.name)
        if (!known.includes(p.targetCube)) {
          return yield* Effect.fail(
            new BadRequest({
              message: `no cube called "${p.targetCube}" is mounted. Mounted: ${known.join(", ")}`,
            }),
          )
        }
        if (p.targetCube === "customfields") {
          return yield* Effect.fail(new BadRequest({ message: "customfields cannot add fields to itself" }))
        }
        // Review fix 9 (QWB-46): a definition named like a DECLARED field can never hold a
        // value -- the kernel's fold never touches declared keys -- and publishing it would
        // advertise two fields under one name. Refused at the door.
        const published = catalogue().find((c) => c.name === p.targetCube)?.metadata?.fields ?? []
        if (published.some((f) => f.name === p.name)) {
          return yield* Effect.fail(
            new BadRequest({ message: `"${p.name}" is already a declared field on ${p.targetCube}` }),
          )
        }
        if (p.fieldType === "select" && p.options.length === 0) {
          return yield* Effect.fail(new BadRequest({ message: `a "select" field needs at least one option` }))
        }
        const existing = yield* definitionsFor(store, p.targetCube)
        if (existing.some((d) => d.name === p.name)) {
          return yield* Effect.fail(
            new BadRequest({ message: `"${p.name}" is already defined on ${p.targetCube}` }),
          )
        }

        const d = (yield* store.insert(DEFS, ENTITY, "cf", {
          targetCube: p.targetCube,
          name: p.name,
          label: p.label || p.name,
          fieldType: p.fieldType,
          options: [...p.options],
          required: p.required,
          position: p.position,
        })) as DefRow
        yield* refreshSnapshot(store, snapshot)
        yield* bus.publish("customfields.defined", { id: d.id, cube: d.targetCube, name: d.name })
        return d
      }),

    update: ({ path, payload }: { path: { readonly id: string }; payload: Record<string, unknown> }) =>
      Effect.gen(function* () {
        yield* requirePermission("customfields:write")
        if (Object.keys(payload).length === 0) {
          return yield* Effect.fail(new BadRequest({ message: "patch is empty — nothing to change" }))
        }
        const current = yield* store.byId<DefRow>(DEFS, path.id)
        if (!current) {
          return yield* Effect.fail(new NotFound({ message: `no custom field ${path.id}` }))
        }
        const merged = { ...current, ...payload } as DefRow
        // `?.length ?? 0` rather than `.length`: a patch may leave `options` absent, and a
        // select with no options is refused for the same reason either way.
        if (merged.fieldType === "select" && (merged.options?.length ?? 0) === 0) {
          return yield* Effect.fail(new BadRequest({ message: `a "select" field needs at least one option` }))
        }
        const updated = (yield* store.update(DEFS, path.id, payload)) as DefRow
        yield* refreshSnapshot(store, snapshot)
        return updated
      }),

    remove: ({ path }: { path: { readonly id: string } }) =>
      Effect.gen(function* () {
        yield* requirePermission("customfields:write")
        const current = yield* store.byId<DefRow>(DEFS, path.id)
        if (!current) {
          return yield* Effect.fail(new NotFound({ message: `no custom field ${path.id}` }))
        }
        // Soft delete of the DEFINITION ONLY (QWB-46 step 5). The values live in the target
        // rows' own bodies; touching them from here is impossible by construction and wrong by
        // design -- they become orphans, reported by the orphans report, never silently deleted.
        yield* store.update(DEFS, path.id, { deleted: true })
        yield* refreshSnapshot(store, snapshot)
        yield* bus.publish("customfields.removed", {
          id: current.id,
          cube: current.targetCube,
          name: current.name,
        })
        return { removed: `${current.targetCube}.${current.name}` }
      }),
  }
}
