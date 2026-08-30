// Unit tests for the customfields pure logic: validation and orphan computation. These pin the
// rules the pack owns (QWB-46): the definition validates strictly, and deleting a definition
// never deletes values -- it turns them into reportable orphans.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { displayValue, NAME, orphanValues, reject, type DefRow } from "./schema.ts"

const def = (over: Partial<DefRow> = {}): DefRow =>
  ({
    id: "cf-1",
    type: "CustomField",
    createdAt: "2026-08-30T00:00:00.000Z",
    deleted: false,
    targetCube: "crm/contacts",
    name: "cnp",
    label: "CNP",
    fieldType: "text",
    options: [],
    required: false,
    position: 0,
    ...over,
  }) as DefRow

describe("definition validation", () => {
  it("accepts a value the definition allows", () => {
    assert.equal(reject(def(), "plain text"), undefined)
    assert.equal(reject(def({ fieldType: "number" }), "7"), undefined)
    assert.equal(reject(def({ fieldType: "bool" }), "true"), undefined)
  })

  it("refuses a value that is not of the declared type, with a reason naming the field", () => {
    assert.match(reject(def({ fieldType: "number" }), "seven") ?? "", /cnp/)
    assert.match(reject(def({ fieldType: "date" }), "30/08/2026") ?? "", /YYYY-MM-DD/)
    assert.match(reject(def({ fieldType: "bool" }), "yes") ?? "", /"true" or "false"/)
  })

  it("a select value must be one of the options", () => {
    const d = def({ fieldType: "select", options: ["gold", "silver"] })
    assert.equal(reject(d, "gold"), undefined)
    assert.match(reject(d, "bronze") ?? "", /not one of the options/)
  })

  it("a required field cannot be blanked; an optional one can", () => {
    assert.match(reject(def({ required: true }), "") ?? "", /is required/)
    assert.equal(reject(def({ required: false }), ""), undefined)
  })

  it("a text value is capped at 1000 characters", () => {
    assert.equal(reject(def(), "x".repeat(1000)), undefined)
    assert.match(reject(def(), "x".repeat(1001)) ?? "", /1000 characters/)
  })

  it("a field name must survive being a JSON key and a form input name", () => {
    assert.equal(NAME.source, "^[a-z][a-zA-Z0-9_]{0,31}$")
    assert.equal(NAME.test("cnp"), true)
    assert.equal(NAME.test("2cnp"), false)
    assert.equal(NAME.test("has space"), false)
  })
})

describe("orphan values (QWB-46 step 5)", () => {
  it("reports a custom key no active definition names", () => {
    const rows = [
      { id: "cont-1", custom: { cnp: "123", gone: "42" }, deleted: false },
    ]
    const orphans = orphanValues([def()], rows)
    assert.deepEqual(orphans, [{ rowId: "cont-1", name: "gone", value: "42", deleted: false }])
  })

  it("values of a deleted definition stay in the rows and are reported, never deleted", () => {
    // After `birthday` is deleted, no active definition names it -- so it is an orphan.
    const rows = [{ id: "cont-2", custom: { birthday: "1996-02-29" }, deleted: false }]
    const orphans = orphanValues([def({ name: "cnp" })], rows)
    assert.deepEqual(orphans, [{ rowId: "cont-2", name: "birthday", value: "1996-02-29", deleted: false }])
  })

  it("a soft-deleted definition still protects nothing: only ACTIVE definitions count", () => {
    const rows = [{ id: "cont-3", custom: { cnp: "123" }, deleted: false }]
    const orphans = orphanValues([def({ deleted: true })], rows)
    assert.equal(orphans.length, 0)
  })

  it("non-string values are rendered as text in the report", () => {
    const rows = [{ id: "cont-4", custom: { gone: 7 }, deleted: true }]
    assert.deepEqual(orphanValues([], rows), [{ rowId: "cont-4", name: "gone", value: "7", deleted: true }])
  })

  it("displayValue renders nothing for absent or null values", () => {
    assert.equal(displayValue(undefined), "")
    assert.equal(displayValue(null), "")
    assert.equal(displayValue(true), "true")
  })
})
