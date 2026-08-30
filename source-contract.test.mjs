import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sources = ["cubes/customfields/index.ts"]

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
      ["customfields:read", "customfields:write", "customfields:values"],
    )
  })

  it("uses only public qwbe-core subpaths", () => {
    for (const source of sources) {
      const text = readFileSync(new URL(source, import.meta.url), "utf8")
      assert.doesNotMatch(text, /(?:\.\.\/)+src\//, `${source} imports Qwbe source internals`)
      assert.doesNotMatch(text, /qwbe-core\/src\//, `${source} imports qwbe-core internals`)
    }
  })
})
