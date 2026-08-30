// The CUSTOMFIELDS schemas and the whole of value validation, in one place.
//
// Ported to the QWB-46 contract (storage decision of 2026-08-30): DEFINITIONS live in this
// cube's own table; VALUES live in the target row's own body, under the reserved `custom`
// sub-object, written and read through the target cube's own API. This cube therefore no longer
// holds a values table, and its values endpoint VALIDATES ONLY -- it stores nothing, because it
// cannot: another cube's row belongs to that cube's store, and the fold into `custom` happens
// in the kernel when the target's own endpoints are called.
//
// Validation is STRICT from the first version: the type is checked, `select` options are
// checked, a required field cannot be blanked. The definition owns the check; nothing trusts
// the frontend.

import { Schema } from "effect"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { PageParams } from "qwbe-core/pagination"

export const DEFS = "customfield_defs"
export const ENTITY = "CustomField"

/**
 * A field name has to survive being a JSON key, a form input name and a column header, so it is
 * kept to the shape every one of those accepts without quoting.
 */
export const NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/

export const FieldType = Schema.Literal("text", "number", "date", "bool", "select")
export type FieldTypeName = typeof FieldType.Type

export const CustomField = Schema.Struct({
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

export const CustomFieldCreate = Schema.Struct({
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
 * Values are stored in rows against the name and read through the target's own API. Changing
 * either would silently reinterpret every value already stored, which is the kind of edit that
 * looks harmless in a form and is unrecoverable in the data. Delete the field and make a new one.
 */
export const CustomFieldUpdate = Schema.partial(
  Schema.Struct({
    label: Schema.String,
    options: Schema.Array(Schema.String),
    required: Schema.Boolean,
    position: Schema.Number,
  }),
).annotations({ identifier: "CustomFieldUpdate" })

/** One field as a form needs it: what it is, plus what this row currently holds. */
export const FieldWithValue = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  fieldType: FieldType,
  options: Schema.Array(Schema.String),
  required: Schema.Boolean,
  position: Schema.Number,
  value: Schema.String,
}).annotations({ identifier: "FieldWithValue" })

export const RowFields = Schema.Struct({
  cube: Schema.String,
  rowId: Schema.String,
  fields: Schema.Array(FieldWithValue),
}).annotations({ identifier: "RowFields" })

/**
 * The lookup and the address live in the URL params and the body rather than the path: the
 * current entity enforcement gives every entity-cube endpoint exactly one path parameter (the
 * entity's own id), and a values address belongs to ANOTHER cube's row, so it cannot be a path
 * segment here.
 *
 * QWB-46: the lookup READS the target row's `custom` sub-object (through the kernel-provided
 * rows reader); the write VALIDATES ONLY. Nothing is stored from here.
 */
export const ValuesLookup = Schema.Struct({
  cube: Schema.String,
  rowId: Schema.String,
}).annotations({ identifier: "ValuesLookup" })

export const ValuesWrite = Schema.Struct({
  cube: Schema.String,
  rowId: Schema.String,
  values: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: "ValuesWrite" })

/** The orphan report: values still in rows whose definition is gone (QWB-46 step 5). */
export const OrphansLookup = Schema.Struct({
  cube: Schema.String,
}).annotations({ identifier: "OrphansLookup" })

export const OrphanValue = Schema.Struct({
  rowId: Schema.String,
  name: Schema.String,
  value: Schema.String,
  /** Review fix 11 (QWB-46): the row is soft-deleted -- the value is still stored data. */
  deleted: Schema.Boolean,
}).annotations({ identifier: "OrphanValue" })

export const OrphansReport = Schema.Struct({
  cube: Schema.String,
  orphans: Schema.Array(OrphanValue),
}).annotations({ identifier: "OrphansReport" })

export const ListParams = Schema.Struct({
  ...PageParams.fields,
  /** Narrows the list to one cube's fields. The screens always pass it; the API does not insist. */
  cube: Schema.optional(Schema.String),
})

export type DefRow = typeof CustomField.Type

/**
 * The whole of the validation, in one place, returning the reason rather than a boolean.
 *
 * A reason is what makes a 400 useful: "not one of the options" tells a person what to do,
 * "invalid" tells them to guess.
 */
export const reject = (def: DefRow, value: string): string | undefined => {
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

export const byPosition = (a: DefRow, b: DefRow) => a.position - b.position || a.name.localeCompare(b.name)

/** Row values may hold any JSON; the form reads strings, so non-strings are rendered as text. */
export const displayValue = (value: unknown): string => (value === undefined || value === null ? "" : String(value))

export const summary = (d: DefRow): SummaryRow => ({
  id: d.id,
  title: d.label || d.name,
  details: [
    { key: "cube", value: d.targetCube },
    { key: "name", value: d.name },
    { key: "type", value: d.fieldType },
    { key: "required", value: String(d.required) },
  ],
})

/** The definition shape the kernel's provider registry expects (catalogue.ts, QWB-46). */
export const toDefinition = (d: DefRow) => ({
  name: d.name,
  label: d.label || d.name,
  fieldType: d.fieldType,
  required: d.required,
  options: d.options,
  position: d.position,
})

/**
 * The orphan computation, pure so it is testable without a store: every `custom` key on a row
 * that no active definition names is an orphan. Values are REPORTED, never deleted -- deleting
 * a definition must not damage existing rows (QWB-46 step 5). Since review fixes 1 and 2 gate
 * every write path on an active definition, an orphan is a value whose DEFINITION was deleted;
 * the row's `deleted` flag says whether the row itself is gone too.
 */
export const orphanValues = (
  defs: ReadonlyArray<DefRow>,
  rows: ReadonlyArray<{
    readonly id: string
    readonly custom: Record<string, unknown>
    readonly deleted: boolean
  }>,
): ReadonlyArray<{ rowId: string; name: string; value: string; deleted: boolean }> => {
  const known = new Set(defs.map((d) => d.name))
  const out: Array<{ rowId: string; name: string; value: string; deleted: boolean }> = []
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.custom)) {
      if (!known.has(name)) out.push({ rowId: row.id, name, value: displayValue(value), deleted: row.deleted })
    }
  }
  return out
}
