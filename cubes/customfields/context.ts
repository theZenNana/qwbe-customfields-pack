// Shared context for the customfields handlers, split out (QWB-46: split the file, never raise
// the cap). The in-memory snapshot exists because the kernel's provider registry is a
// synchronous read while definitions live in the store; it is refreshed on load and on every
// write, so the catalogue's custom metadata and the orphan report see current definitions.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { type DefRow, DEFS } from "./schema.ts"

export type PackTools = Pick<CubeTools, "store" | "bus" | "catalogue" | "customFields">

type Store = CubeTools["store"]

/** The live in-memory snapshot the kernel's provider reads; refreshed on load and on every write. */
export type Snapshot = { current: ReadonlyArray<DefRow> }

export const definitionsFor = (store: Store, cube: string) =>
  Effect.gen(function* () {
    const rows = yield* store.all<DefRow>(DEFS)
    return rows.filter((d) => d.deleted === false && d.targetCube === cube).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  })

/** Reload the snapshot from the store. Run at create (fire-and-forget) and after every write. */
export const refreshSnapshot = (store: Store, snapshot: Snapshot) =>
  Effect.gen(function* () {
    const rows = yield* store.all<DefRow>(DEFS)
    snapshot.current = rows.filter((d) => d.deleted === false)
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

/** The guard every handler path runs through: the tool the manifest declaration earns. */
export const customFieldsTool = (tools: PackTools) => {
  const customFields = tools.customFields
  if (!customFields) throw new Error("customfields cube requires the customFields tool")
  return customFields
}
