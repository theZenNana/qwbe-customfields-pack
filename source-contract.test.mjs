import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { describe, it } from "node:test"

// Review fix 24 (QWB-46): the list used to be hardcoded, so a new file in cubes/customfields/
// was never checked. The cube directory is globbed, and the boundary now also refuses the
// forbidden builtins (a cube gets its filesystem access from the kernel, never node:fs) and
// keeps every source file inside its size cap.
const CUBE = new URL("cubes/customfields/", import.meta.url)
const sources = readdirSync(CUBE).filter((f) => statSync(new URL(f, CUBE)).isFile() && f.endsWith(".ts"))
assert.ok(sources.length > 0, "the cube directory lists at least one source file")

const CAP = 6000

// The same metric the kernel's size gate uses (probes/size-lib.mjs): `code` characters, i.e.
// every byte except comments. Capping raw bytes would make deleting an explanation the
// cheapest way to go green, which is the opposite of the point.
const stripComments = (source) => {
  let out = ""
  let quote = null
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]
    if (quote) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i++
      } else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out
}

const codeChars = (file) => stripComments(readFileSync(new URL(file, CUBE), "utf8")).length

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

  it("uses only public qwbe-core subpaths and no forbidden builtins", () => {
    for (const source of sources) {
      const text = readFileSync(new URL(source, CUBE), "utf8")
      assert.doesNotMatch(text, /(?:\.\.\/)+src\//, `${source} imports Qwbe source internals`)
      assert.doesNotMatch(text, /qwbe-core\/src\//, `${source} imports qwbe-core internals`)
      // A cube never touches the filesystem or spawns processes: the kernel lends narrow
      // capabilities instead. Same rule the kernel's package contract enforces at install.
      assert.doesNotMatch(text, /from "(node:)?fs"/, `${source} imports node:fs`)
      assert.doesNotMatch(text, /from "(node:)?child_process"/, `${source} imports child_process`)
      assert.ok(codeChars(source) <= CAP, `${source} is over the ${CAP}-code-character cap`)
    }
  })
})
