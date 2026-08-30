import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sources = ["cubes/customfields/index.ts", "cubes/customfields/schema.ts", "cubes/customfields/handlers.ts", "cubes/customfields/values.ts", "cubes/customfields/context.ts"]

describe("Customfields source package boundary", () => {
  it("declares one top-level cube and loads", async () => {
    const packageManifest = JSON.parse(readFileSync(new URL("qwbe-package.json", import.meta.url), "utf8"))
    assert.deepEqual(packageManifest.cubes, ["customfields"])
    const { cube } = await import("./cubes/customfields/index.ts")
    assert.equal(cube.manifest.name, "customfields")
    // Deliberately NOT an entity cube: the values lookup addresses another cube's row and the
    // entity mediation would misread it (see the comment above the manifest).
    assert.equal(cube.manifest.entity, undefined)
    assert.deepEqual(
      cube.manifest.permissions.map((p) => p.name),
      // QWB-46: the separate `customfields:values` gate is gone -- values are written through
      // the target cube's own API, so this cube only reads (validate pre-flight, lookups) and
      // writes definitions. The orphan report rides on the admin write gate.
      ["customfields:read", "customfields:write"],
    )
    // QWB-46: the pack declares the capability that makes values-in-rows possible: the kernel
    // hands the customFields tool (register definitions, read target rows for orphans).
    assert.equal(cube.manifest.providesCustomFields, true)
    // No sidecar values table anymore: definitions only.
    assert.deepEqual(cube.manifest.tables, ["customfield_defs"])
  })

  it("uses only public qwbe-core subpaths", () => {
    for (const source of sources) {
      const text = readFileSync(new URL(source, import.meta.url), "utf8")
      assert.doesNotMatch(text, /(?:\.\.\/)+src\//, `${source} imports Qwbe source internals`)
      assert.doesNotMatch(text, /qwbe-core\/src\//, `${source} imports qwbe-core internals`)
    }
  })
})
