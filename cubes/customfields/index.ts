// The CUSTOMFIELDS cube — extra fields for any cube, added by an administrator at runtime.
//
// Configurable fields extend another mounted cube without changing that cube's source. For
// every module, you can extend it with custom fields. A separate cube that can give fields to
// the other cubes.
//
// WHERE THE VALUES LIVE (QWB-46, storage decision of 2026-08-30).
//
// In the TARGET ROW itself. The kernel keeps a row body as jsonb under a GIN index
// (ADR-0001 sections 3-4) and no longer silently drops keys a cube's static payload schema does
// not declare: they are folded into one reserved sub-object of the body, `custom`, by the
// kernel's own composition seam. So a value is written through the TARGET cube's own API --
//
//     POST /crm/contacts {"name":"Test","cnp":"123"}   -> 200, row body carries custom.cnp
//     GET  /crm/contacts/<id>                          -> the row, `custom` included
//
// -- persisted by the target's own store operations, queryable through the GIN index, and
// sorted/filtered like any other jsonb key. The old sidecar table is gone; this cube now owns
// DEFINITIONS only, plus the validation and the orphan report.
//
// WHAT THIS CUBE DOES WITH THE KERNEL:
//   - `providesCustomFields: true` in the manifest: the kernel hands the `customFields` tool,
//     and this cube registers its active definitions so the catalogue's metadata publishes them
//     marked `custom: true` (a frontend must be able to tell them apart from static fields).
//   - the same tool reads a target cube's rows, so deleting a definition can REPORT the values
//     it leaves behind as orphans. Deleting never deletes values: they stay in the rows.
//
// The cube it extends is named as a STRING and validated against the catalogue the kernel hands
// every cube. Nothing is imported, and a definition pointing at a cube that is not mounted is
// refused at the door instead of becoming an invisible field.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube, type CubeTools } from "qwbe-core/cube"
import { BadRequest, Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import {
  CustomField,
  CustomFieldCreate,
  CustomFieldUpdate,
  DEFS,
  displayValue,
  type DefRow,
  byPosition,
  orphanValues,
  ListParams,
  OrphansLookup,
  OrphansReport,
  RowFields,
  summary,
  toDefinition,
  ValuesLookup,
  ValuesWrite,
} from "./schema.ts"
import { customFieldsTool, type PackTools, refreshSnapshot, type Snapshot } from "./context.ts"
import { definitionHandlers } from "./handlers.ts"
import { valuesHandlers } from "./values.ts"

const group = HttpApiGroup.make("customfields")
  .add(
    HttpApiEndpoint.get("list")`/customfields`
      .setUrlParams(ListParams)
      .addSuccess(PageOf(CustomField))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("define")`/customfields`
      .setPayload(CustomFieldCreate)
      .addSuccess(CustomField)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("update")`/customfields/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(CustomFieldUpdate)
      .addSuccess(CustomField)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("remove")`/customfields/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Schema.Struct({ removed: Schema.String }))
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    // READ: definitions plus the row's current values, read from the target row itself.
    HttpApiEndpoint.get("valuesFor")`/customfields/values`
      .setUrlParams(ValuesLookup)
      .addSuccess(RowFields)
      .addError(Forbidden),
  )
  .add(
    // VALIDATES ONLY. Values are saved through the target cube's own API; this stores nothing.
    HttpApiEndpoint.put("setValues")`/customfields/values`
      .setPayload(ValuesWrite)
      .addSuccess(RowFields)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(
    // The orphan report: values still in rows whose definition was deleted (QWB-46 step 5).
    HttpApiEndpoint.get("orphans")`/customfields/orphans`
      .setUrlParams(OrphansLookup)
      .addSuccess(OrphansReport)
      .addError(Forbidden),
  )
  .middleware(Authorization)

// NOT an entity cube, deliberately. The entity mediation shapes an entity cube's surface:
// the no-param GET must BE the entity list (per-row visibility) and path parameters are the
// entity's own id. This cube's surface is not that: definitions are admin metadata, and the
// values lookup addresses ANOTHER cube's row, which an entity id here would misname. Every
// handler keeps its own permission gate instead — exactly the gates the pre-QWB-15 original
// used. ENTITY stays as the store row label for the definitions table.
export const cube = defineCube(group, {
  manifest: {
    name: "customfields",
    screen: true,
    tables: [DEFS],
    sortable: ["targetCube", "name", "label", "fieldType", "position", "createdAt"],
    requiresAuth: true,
    providesCustomFields: true,
    permissions: [
      { name: "customfields:read", roles: ["admin", "reader"] },
      // Defining a field changes what every form for that cube shows, so it is an admin action.
      // The orphan report reads other cubes' rows, so it rides on the same admin gate.
      { name: "customfields:write", roles: ["admin"] },
    ],
    publishes: ["customfields.defined", "customfields.removed"],
  },

  create: ({ store, bus, catalogue, customFields }: CubeTools) => {
    if (!customFields) {
      // Unreachable when the manifest declares providesCustomFields: the kernel wires the tool
      // exactly then. Kept as a guard so the type is honest without non-null assertions.
      throw new Error("manifest declares providesCustomFields but the kernel handed no customFields tool")
    }
    const tools: PackTools = { store, bus, catalogue, customFields }
    const snapshot: Snapshot = { current: [] }
    // Load the definitions snapshot asynchronously: the kernel's provider registry is a
    // synchronous read, and metadata is served per request, so the first catalogue call after
    // boot races this load at worst and shows no custom fields until it lands.
    void refreshSnapshot(store, snapshot)

    // The kernel publishes these definitions as custom metadata of each target cube.
    customFieldsTool(tools).register((cube) =>
      snapshot.current
        .filter((d) => d.targetCube === cube)
        .sort(byPosition)
        .map(toDefinition),
    )

    return {
      commands: [
        {
          name: "customfields:count",
          summary: "how many custom fields are defined",
          permission: "customfields:read",
          run: () => Effect.map(store.count(DEFS), (n) => String(n)),
        },
        {
          name: "customfields:list",
          summary: "the defined fields — `customfields:list [cube]`",
          permission: "customfields:read",
          maxArgs: 1,
          run: (args) =>
            Effect.gen(function* () {
              const rows = yield* store.all<DefRow>(DEFS)
              const wanted = args[0]
              return (
                rows
                  .filter((d) => d.deleted === false && (!wanted || d.targetCube === wanted))
                  .sort((a, b) => a.targetCube.localeCompare(b.targetCube) || byPosition(a, b))
                  .map(
                    (d) =>
                      `${d.targetCube}\t${d.name}\t${d.fieldType}${d.required ? "\trequired" : ""}${
                        d.options.length > 0 ? `\t[${d.options.join("|")}]` : ""
                      }`,
                  )
                  .join("\n") || "(none)"
              )
            }),
        },
        {
          name: "customfields:orphans",
          summary: "custom values whose definition is gone — `customfields:orphans <cube>`",
          permission: "customfields:write",
          maxArgs: 1,
          run: (args) =>
            Effect.gen(function* () {
              const cube = args[0]
              if (!cube) return "usage: customfields:orphans <cube>"
              const defs = yield* store.all<DefRow>(DEFS)
              const active = defs.filter((d) => d.deleted === false && d.targetCube === cube).sort(byPosition)
              const rows = yield* customFields.rows(cube)
              const orphans = orphanValues(active, rows)
              return (
                orphans.map((o) => `${o.rowId}\t${o.name}\t${displayValue(o.value)}`).join("\n") ||
                "(no orphans)"
              )
            }),
        },
      ],

      handlers: { ...definitionHandlers(tools, snapshot), ...valuesHandlers(tools, snapshot) },

      relational: {
        search: (field, value, page) =>
          Effect.gen(function* () {
            const p = yield* store.page<DefRow>(DEFS, page, { field, value })
            return { rows: p.rows.map(summary), total: p.total }
          }),

        summaryById: (id) =>
          Effect.gen(function* () {
            const d = yield* store.byId<DefRow>(DEFS, id)
            return d ? summary(d) : undefined
          }),
      },
    }
  },
})
