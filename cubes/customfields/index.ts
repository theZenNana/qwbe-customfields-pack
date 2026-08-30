// The CUSTOMFIELDS cube — extra fields for any cube, added by an administrator at runtime.
//
// Configurable fields extend another mounted cube without changing that cube's source. For
// every module, you can extend it with custom fields. A separate cube that can give fields to
// the other cubes.
//
// WHERE THE VALUES LIVE, AND WHY NOT IN THE TARGET ROW.
//
// The obvious design is to write the extra values into the target entity's own row: the store
// keeps a JSON blob, so anything fits without a migration. It does not work, and this was
// measured rather than assumed. A key the target cube does not declare in its payload schema is
// SILENTLY DROPPED on the way in:
//
//     POST /contacts {"lastName":"Test","cnp":"123"}   → 200, and the stored row has no `cnp`
//     POST /notes    {"title":"T","extra":"x"}         → 200, and the stored row has no `extra`
//
// No error, no value. That is the worst of both: the caller is told everything worked. Making it
// work would mean every target cube declaring a `custom` field in its own schema — which is the
// cooperation this design exists to avoid, since a custom field must be addable to a cube whose
// author never heard of this one.
//
// So the values live HERE, next to the definitions. The cube that owns the definition owns the
// write, which means validation is STRICT from the first version: the type is checked, `select`
// options are checked, a required field cannot be blanked. No kernel hook, no trust in the
// frontend.
//
// WHAT THAT COSTS, said plainly: a custom value is not in the target's row, so a list cannot be
// sorted or filtered by one — `json_extract` in the store only sees the target cube's own body.
// And a detail screen needs one extra request. The trade is "no sorting on custom fields" against
// "values accepted and silently lost". This takes the first.
//
// The cube it extends is named as a STRING and validated against the catalogue the kernel hands
// every cube. Nothing is imported, and a definition pointing at a cube that is not mounted is
// refused at the door instead of becoming an invisible field.
//
// RESTORED (2026-08-30) from the pre-QWB-15 source kept at ZRHive/qwbe-packs/store, ported to
// the current public cube contract the same way crm-pack's contacts cube was ported on QWB-30:
// `defineCube` from `qwbe-core/cube`, public subpath imports only, no relative reach into the
// kernel. Behaviour is unchanged: same tables, same permissions, same events.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube, type CubeTools } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { BadRequest, Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

const DEFS = "customfield_defs"
const VALUES = "customfield_values"
const ENTITY = "CustomField"

/**
 * A field name has to survive being a JSON key, a form input name and a column header, so it is
 * kept to the shape every one of those accepts without quoting.
 */
const NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/

const FieldType = Schema.Literal("text", "number", "date", "bool", "select")
type FieldTypeName = typeof FieldType.Type

const CustomField = Schema.Struct({
  ...EntityMeta,
  /** The cube this field is added to. A string, checked against the catalogue — never an import. */
  targetCube: Schema.String,
  name: Schema.String,
  label: Schema.String,
  fieldType: FieldType,
  /** Only meaningful for `select`. Empty for everything else. */
  options: Schema.Array(Schema.String),
  required: Schema.Boolean,
  /** Where it sits in the form. Ties are broken by name, so the order is never arbitrary. */
  position: Schema.Number,
}).annotations({ identifier: "CustomField" })

const CustomFieldCreate = Schema.Struct({
  targetCube: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  fieldType: FieldType,
  label: Schema.optionalWith(Schema.String, { default: () => "" }),
  options: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  required: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  position: Schema.optionalWith(Schema.Number, { default: () => 0 }),
}).annotations({ identifier: "CustomFieldCreate" })

/**
 * What a definition may change afterwards — deliberately not `name`, `targetCube` or `fieldType`.
 *
 * Values are stored against the name and validated against the type. Changing either would
 * silently reinterpret every value already stored, which is the kind of edit that looks harmless
 * in a form and is unrecoverable in the data. Delete the field and make a new one.
 */
const CustomFieldUpdate = Schema.partial(
  Schema.Struct({
    label: Schema.String,
    options: Schema.Array(Schema.String),
    required: Schema.Boolean,
    position: Schema.Number,
  }),
).annotations({ identifier: "CustomFieldUpdate" })

/** One field as a form needs it: what it is, plus what this row currently holds. */
const FieldWithValue = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  fieldType: FieldType,
  options: Schema.Array(Schema.String),
  required: Schema.Boolean,
  position: Schema.Number,
  value: Schema.String,
}).annotations({ identifier: "FieldWithValue" })

const RowFields = Schema.Struct({
  cube: Schema.String,
  rowId: Schema.String,
  fields: Schema.Array(FieldWithValue),
}).annotations({ identifier: "RowFields" })

/**
 * Values arrive as a map of name to string.
 *
 * Everything is a string on the wire — including numbers and booleans — because the type is the
 * definition's business, not the transport's. It is checked here before anything is stored.
 */
const ValuesWrite = Schema.Struct({
  values: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: "ValuesWrite" })

const ListParams = Schema.Struct({
  ...PageParams.fields,
  /** Narrows the list to one cube's fields. The screens always pass it; the API does not insist. */
  cube: Schema.optional(Schema.String),
})

type DefRow = typeof CustomField.Type
type ValueRow = typeof EntityMeta & {
  id: string
  type: string
  createdAt: string
  deleted: boolean
  owner: string
  targetCube: string
  rowId: string
  name: string
  value: string
}

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
    HttpApiEndpoint.get(
      "valuesFor",
    )`/customfields/values/${HttpApiSchema.param("cube", Schema.String)}/${HttpApiSchema.param("rowId", Schema.String)}`
      .addSuccess(RowFields)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.put(
      "setValues",
    )`/customfields/values/${HttpApiSchema.param("cube", Schema.String)}/${HttpApiSchema.param("rowId", Schema.String)}`
      .setPayload(ValuesWrite)
      .addSuccess(RowFields)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .middleware(Authorization)

/** One key per row of a target cube, so a lookup is a single indexed comparison. */
const ownerKey = (cube: string, rowId: string) => `${cube}:${rowId}`

const byPosition = (a: DefRow, b: DefRow) => a.position - b.position || a.name.localeCompare(b.name)

/**
 * The whole of the validation, in one place, returning the reason rather than a boolean.
 *
 * A reason is what makes a 400 useful: "not one of the options" tells a person what to do,
 * "invalid" tells them to guess.
 */
const reject = (def: DefRow, value: string): string | undefined => {
  if (value === "") return def.required ? `"${def.name}" is required and cannot be emptied` : undefined
  const checks: Record<FieldTypeName, () => string | undefined> = {
    text: () => (value.length > 1000 ? `"${def.name}" is longer than 1000 characters` : undefined),
    number: () => (Number.isFinite(Number(value)) ? undefined : `"${def.name}" must be a number, got "${value}"`),
    date: () =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : `"${def.name}" must be a date as YYYY-MM-DD, got "${value}"`,
    bool: () =>
      value === "true" || value === "false" ? undefined : `"${def.name}" must be "true" or "false", got "${value}"`,
    select: () =>
      def.options.includes(value)
        ? undefined
        : `"${value}" is not one of the options for "${def.name}": ${def.options.join(", ") || "(none defined)"}`,
  }
  return checks[def.fieldType]()
}

const summary = (d: DefRow): SummaryRow => ({
  id: d.id,
  title: d.label || d.name,
  details: [
    { key: "cube", value: d.targetCube },
    { key: "name", value: d.name },
    { key: "type", value: d.fieldType },
    { key: "required", value: String(d.required) },
  ],
})

export const cube = defineCube(group, {
  manifest: {
    name: "customfields",
    tables: [DEFS, VALUES],
    entity: ENTITY,
    sortable: ["targetCube", "name", "label", "fieldType", "position", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "customfields:read", roles: ["admin", "reader"] },
      // Defining a field changes what every form for that cube shows, so it is an admin action.
      { name: "customfields:write", roles: ["admin"] },
      // Filling one in is ordinary data entry, and separate on purpose: a role can be allowed to
      // fill fields in without being allowed to invent them.
      { name: "customfields:values", roles: ["admin"] },
    ],
    publishes: ["customfields.defined", "customfields.removed", "customfields.valueSet"],
  },

  create: ({ store, bus, catalogue }: CubeTools) => {
    const definitionsFor = (cube: string) =>
      Effect.gen(function* () {
        const rows = yield* store.all<DefRow>(DEFS)
        return rows.filter((d) => d.targetCube === cube).sort(byPosition)
      })

    const valuesFor = (cube: string, rowId: string) =>
      Effect.gen(function* () {
        const rows = yield* store.all<ValueRow>(VALUES)
        const key = ownerKey(cube, rowId)
        return new Map(rows.filter((v) => v.owner === key).map((v) => [v.name, v.value]))
      })

    /** Definitions and values in one shape, which is what a form actually needs. */
    const rowFields = (cube: string, rowId: string) =>
      Effect.gen(function* () {
        const defs = yield* definitionsFor(cube)
        const values = yield* valuesFor(cube, rowId)
        return {
          cube,
          rowId,
          // Driven by the DEFINITIONS, so a value left behind by a deleted field simply stops
          // being shown rather than reappearing as a mystery column.
          fields: defs.map((d) => ({
            name: d.name,
            label: d.label || d.name,
            fieldType: d.fieldType,
            options: d.options,
            required: d.required,
            position: d.position,
            value: values.get(d.name) ?? "",
          })),
        }
      })

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
                  .filter((d) => !wanted || d.targetCube === wanted)
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
      ],

      handlers: {
        list: ({ urlParams }) =>
          Effect.gen(function* () {
            yield* requirePermission("customfields:read")
            const page = pageRequest(urlParams)
            return yield* urlParams.cube
              ? store.page<DefRow>(DEFS, page, { field: "targetCube", value: urlParams.cube })
              : store.page<DefRow>(DEFS, page)
          }),

        define: ({ payload }) =>
          Effect.gen(function* () {
            yield* requirePermission("customfields:write")

            if (!NAME.test(payload.name)) {
              return yield* Effect.fail(
                new BadRequest({
                  message: `name "${payload.name}" must match ${NAME} — a letter, then letters, digits or underscores`,
                }),
              )
            }
            // A field on a cube that is not there would be invisible and unexplained. The
            // catalogue is metadata the kernel hands every cube; nothing is imported to read it.
            const known = catalogue().map((c) => c.name)
            if (!known.includes(payload.targetCube)) {
              return yield* Effect.fail(
                new BadRequest({
                  message: `no cube called "${payload.targetCube}" is mounted. Mounted: ${known.join(", ")}`,
                }),
              )
            }
            if (payload.targetCube === "customfields") {
              return yield* Effect.fail(new BadRequest({ message: "customfields cannot add fields to itself" }))
            }
            if (payload.fieldType === "select" && payload.options.length === 0) {
              return yield* Effect.fail(new BadRequest({ message: `a "select" field needs at least one option` }))
            }
            const existing = yield* definitionsFor(payload.targetCube)
            if (existing.some((d) => d.name === payload.name)) {
              return yield* Effect.fail(
                new BadRequest({ message: `"${payload.name}" is already defined on ${payload.targetCube}` }),
              )
            }

            const d = (yield* store.insert(DEFS, ENTITY, "cf", {
              ...payload,
              label: payload.label || payload.name,
            })) as DefRow
            yield* bus.publish("customfields.defined", { id: d.id, cube: d.targetCube, name: d.name })
            return d
          }),

        update: ({ path, payload }) =>
          Effect.gen(function* () {
            yield* requirePermission("customfields:write")
            if (Object.keys(payload).length === 0) {
              return yield* Effect.fail(new BadRequest({ message: "patch is empty — nothing to change" }))
            }
            const current = yield* store.byId<DefRow>(DEFS, path.id)
            if (!current) {
              return yield* Effect.fail(new NotFound({ message: `no custom field ${path.id}` }))
            }
            const merged = { ...current, ...payload }
            // `?.length ?? 0` rather than `.length`: a patch may leave `options` absent, and a
            // select with no options is refused for the same reason either way.
            if (merged.fieldType === "select" && (merged.options?.length ?? 0) === 0) {
              return yield* Effect.fail(new BadRequest({ message: `a "select" field needs at least one option` }))
            }
            return (yield* store.update(DEFS, path.id, payload)) as DefRow
          }),

        remove: ({ path }) =>
          Effect.gen(function* () {
            yield* requirePermission("customfields:write")
            const current = yield* store.byId<DefRow>(DEFS, path.id)
            if (!current) {
              return yield* Effect.fail(new NotFound({ message: `no custom field ${path.id}` }))
            }
            // Soft delete, and the VALUES go with it. Leaving them behind was the first version,
            // and the probe caught what that means: define `birthday` as a date, fill it in,
            // delete the field, define `birthday` again as text — and "1996-02-29" came back,
            // now under a type that never validated it. A value belongs to the definition that
            // gave it a meaning; when the meaning goes, so does the value.
            yield* store.update(DEFS, path.id, { deleted: true })
            const orphans = (yield* store.all<ValueRow>(VALUES)).filter(
              (v) => v.targetCube === current.targetCube && v.name === current.name,
            )
            for (const v of orphans) yield* store.update(VALUES, v.id, { deleted: true })
            yield* bus.publish("customfields.removed", {
              id: current.id,
              cube: current.targetCube,
              name: current.name,
            })
            return { removed: `${current.targetCube}.${current.name}` }
          }),

        valuesFor: ({ path }) =>
          Effect.gen(function* () {
            yield* requirePermission("customfields:read")
            // No 404 for a row that does not exist: this cube cannot check another cube's rows
            // without reaching into it, and an empty field list is the honest answer to "what
            // extra fields does this row have" either way.
            return yield* rowFields(path.cube, path.rowId)
          }),

        setValues: ({ path, payload }) =>
          Effect.gen(function* () {
            yield* requirePermission("customfields:values")
            const defs = yield* definitionsFor(path.cube)
            const byName = new Map(defs.map((d) => [d.name, d]))

            // Every refusal happens BEFORE the first write, so a rejected request leaves nothing
            // half-applied. There is no transaction here to lean on.
            const problems: Array<string> = []
            for (const [name, value] of Object.entries(payload.values)) {
              const def = byName.get(name)
              if (!def) {
                problems.push(`"${name}" is not a field on ${path.cube}`)
                continue
              }
              const why = reject(def, value)
              if (why) problems.push(why)
            }
            if (problems.length > 0) {
              return yield* Effect.fail(new BadRequest({ message: problems.join("; ") }))
            }

            const owner = ownerKey(path.cube, path.rowId)
            const existing = (yield* store.all<ValueRow>(VALUES)).filter((v) => v.owner === owner)
            for (const [name, value] of Object.entries(payload.values)) {
              const found = existing.find((v) => v.name === name)
              if (found) {
                yield* store.update(VALUES, found.id, { value })
              } else {
                yield* store.insert(VALUES, "CustomFieldValue", "cfv", {
                  owner,
                  targetCube: path.cube,
                  rowId: path.rowId,
                  name,
                  value,
                })
              }
            }
            yield* bus.publish("customfields.valueSet", {
              cube: path.cube,
              rowId: path.rowId,
              names: Object.keys(payload.values),
            })
            return yield* rowFields(path.cube, path.rowId)
          }),
      },

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
