// The values half of the customfields handlers (QWB-46: split the file, never raise the cap).
//
// The contract these implement: values live in the TARGET row's own body under the kernel's
// reserved `custom` sub-object, written and read through the target cube's own API. So the
// lookup reads the target rows through the kernel-provided rows reader, the write VALIDATES
// ONLY -- it stores nothing, because another cube's row belongs to that cube's store -- and the
// orphan report surfaces values whose definition is gone, without ever deleting them.

import { Effect } from "effect"
import { requirePermission } from "qwbe-core/auth"
import { BadRequest } from "qwbe-core/errors"
import { displayValue, type DefRow, orphanValues, reject } from "./schema.ts"
import { customFieldsTool, definitionsFor, type PackTools, type Snapshot } from "./context.ts"

/** Definitions plus the row's current values, which is what a form actually needs. */
export const rowFields = (tools: PackTools, cube: string, rowId: string) =>
  Effect.gen(function* () {
    const customFields = customFieldsTool(tools)
    const defs = yield* definitionsFor(tools.store, cube)
    const rows = yield* customFields.rows(cube)
    const custom = rows.find((r) => r.id === rowId)?.custom ?? {}
    return {
      cube,
      rowId,
      // Driven by the DEFINITIONS, so a value left behind by a deleted field simply stops being
      // shown here rather than reappearing as a mystery column -- and is reported as an orphan
      // by the orphans report instead.
      fields: defs.map((d) => ({
        name: d.name,
        label: d.label || d.name,
        fieldType: d.fieldType,
        options: d.options,
        required: d.required,
        position: d.position,
        value: displayValue(custom[d.name]),
      })),
    }
  })

export const valuesHandlers = (tools: PackTools, _snapshot: Snapshot) => ({
  // READ: the definitions plus the target row's current values, read from the row itself. No
  // 404 for a row that does not exist: an empty field list is the honest answer to "what extra
  // fields does this row have" either way.
  valuesFor: ({ urlParams }: { urlParams: { readonly cube: string; readonly rowId: string } }) =>
    Effect.gen(function* () {
      yield* requirePermission("customfields:read")
      return yield* rowFields(tools, urlParams.cube, urlParams.rowId)
    }),

  // VALIDATES ONLY. Custom values are saved through the target cube's own API: the kernel
  // folds undeclared keys into the row's `custom` sub-object when THAT cube's endpoints are
  // called. This endpoint stores nothing -- the response is the validated field list, not a
  // confirmation -- and every refusal happens before anything would have been written.
  setValues: ({
    payload,
  }: {
    payload: { readonly cube: string; readonly rowId: string; readonly values: Readonly<Record<string, string>> }
  }) =>
    Effect.gen(function* () {
      yield* requirePermission("customfields:read")
      const { cube, rowId, values } = payload
      const defs = yield* definitionsFor(tools.store, cube)
      const byName = new Map(defs.map((d) => [d.name, d]))

      const problems: Array<string> = []
      for (const [name, value] of Object.entries(values)) {
        const def = byName.get(name)
        if (!def) {
          problems.push(`"${name}" is not a field on ${cube}`)
          continue
        }
        const why = reject(def, value)
        if (why) problems.push(why)
      }
      if (problems.length > 0) {
        return yield* Effect.fail(new BadRequest({ message: problems.join("; ") }))
      }
      return yield* rowFields(tools, cube, rowId)
    }),

  // The orphan report (QWB-46 step 5): values still in rows whose definition is gone. They are
  // REPORTED, never deleted -- deleting a definition must not damage existing rows.
  orphans: ({ urlParams }: { urlParams: { readonly cube: string } }) =>
    Effect.gen(function* () {
      yield* requirePermission("customfields:write")
      const cube = urlParams.cube
      const defs = yield* definitionsFor(tools.store, cube)
      const rows = yield* customFieldsTool(tools).rows(cube)
      return { cube, orphans: orphanValues(defs as ReadonlyArray<DefRow>, rows) }
    }),
})
