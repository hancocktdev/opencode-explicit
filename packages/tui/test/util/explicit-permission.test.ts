// explicit: the "Allow folder (read)" button appears only on outside-folder reads and names the exact folder.
import { describe, expect, test } from "bun:test"
import { permissionFolderLines, permissionFolders, permissionOptionLabel } from "../../src/util/permission"

const outside = (resource: string, access?: string) => ({
  action: "external_directory",
  resources: [resource],
  ...(access ? { metadata: { access } } : {}),
})

describe("explicit: folder button", () => {
  test("an outside-folder file read offers its folder", () => {
    expect(permissionFolders(outside("/outside/repo/file1", "read"))).toEqual(["/outside/repo/*"])
  })

  test("an outside-folder search offers the searched folder itself", () => {
    expect(permissionFolders(outside("/outside/repo/*", "read"))).toEqual(["/outside/repo/*"])
  })

  test("writes, unmarked requests, other actions and top-level files offer nothing", () => {
    expect(permissionFolders(outside("/outside/repo/file1", "write"))).toBeUndefined()
    expect(permissionFolders(outside("/outside/repo/file1"))).toBeUndefined()
    expect(permissionFolders({ action: "read", resources: ["src/a.ts"], metadata: { access: "read" } })).toBeUndefined()
    expect(permissionFolders(outside("/file1", "read"))).toBeUndefined()
  })

  test("the confirmation names the folder, the depth and that writes still ask", () => {
    const lines = permissionFolderLines(["/outside/repo/*"])
    expect(lines[0]).toContain("at any depth")
    expect(lines[0]).toContain("Writes still ask")
    expect(lines[0]).toContain("Nothing is saved")
    expect(lines.slice(1)).toEqual(["- /outside/repo/*"])
    expect(permissionOptionLabel("folder")).toBe("Allow folder (read)")
  })
})
