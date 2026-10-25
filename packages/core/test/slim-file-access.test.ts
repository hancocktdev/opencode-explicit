// slim: outside-folder requests name exactly the path asked about (no `<dir>/*`, no widening to the
// repository root), say whether they read or write, and a recovered filename is asked about too.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity } from "./lib/tool"

const invocation = {
  ...toolIdentity,
  sessionID: Session.ID.make("ses_slim_file_access"),
  id: Tool.CallID.make("call-slim"),
}
const slash = (file: string) => file.replaceAll("\\", "/")

function provide(requests: Permission.AssertInput[]) {
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node]), [
      Location.node.replace(tempLocationLayer),
      Permission.node.replace(
        permissionLayer({
          assert: (input) =>
            Effect.sync(() => {
              requests.push(input)
            }),
        }),
      ),
    ]),
  )
}

describe("slim: outside-folder requests are exact", () => {
  it.live("a file inside a git repository asks for that file only, not the repository", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const repo = path.join(external.path, "reponame1")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(repo, ".git"), { recursive: true })
        await fs.mkdir(path.join(repo, "sibling", "deep"), { recursive: true })
      })
      const access = yield* FileAccess.Service
      const file = yield* access.resolve({ path: path.join(repo, "file1"), kind: "file" })

      yield* access.authorizeExternal([file], invocation, "read")

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        action: "external_directory",
        resources: [slash(path.join(repo, "file1"))],
        save: [slash(path.join(repo, "file1"))],
        metadata: { access: "read" },
      })
    }).pipe(provide(requests))
  })

  it.live("a directory target (search, shell workdir) names its whole tree", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const access = yield* FileAccess.Service
      const directory = yield* access.resolve({ path: external.path, kind: "directory" })

      yield* access.authorizeExternal([directory], invocation, "read")

      expect(requests[0]?.resources).toEqual([slash(path.join(external.path, "*"))])
    }).pipe(provide(requests))
  })

  it.live("the caller's read or write intent is sent with the request", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const access = yield* FileAccess.Service
      const file = yield* access.resolve({ path: path.join(external.path, "notes.txt"), kind: "file" })

      yield* access.authorizeExternal([file], invocation, "write", { filepath: file.absolute })

      expect(requests[0]?.metadata).toEqual({ filepath: file.absolute, access: "write" })
    }).pipe(provide(requests))
  })

  it.live("a recovered filename is asked about like any other file", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const access = yield* FileAccess.Service
      const requested = yield* access.authorizeRead(path.join(external.path, "report final.txt"), invocation)
      yield* access.authorizeRead(path.join(external.path, "report final.txt"), invocation, {
        siblingOf: requested,
      })

      expect(requests.map((request) => request.action)).toEqual([
        "external_directory",
        "read",
        "external_directory",
        "read",
      ])
      expect(requests[2]?.resources).toEqual([slash(path.join(external.path, "report final.txt"))])
    }).pipe(provide(requests))
  })
})
