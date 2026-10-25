// explicit: "always" approvals last for the session (and its subagent sessions) only, are never saved, cover
// exactly the resources asked about (compared literally), and an outside-folder read never covers a write.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionTable } from "@opencode/core/permission/sql"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

const first = Session.ID.make("ses_first")
const later = Session.ID.make("ses_later")
const child = Session.ID.make("ses_child")

function session(id: Session.ID, parent?: Session.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        parent_id: parent,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = []
      }),
    )
  })
}

type Ask = Pick<Permission.AssertInput, "action" | "resources" | "save" | "metadata">

const readSrc: Ask = { action: "read", resources: ["src/index.ts"], save: ["src/*"] }

function assertion(sessionID: Session.ID, id: string, input: Ask = readSrc): Permission.AssertInput {
  return { id: Permission.ID.create(id), sessionID, ...input }
}

// Asks once in `sessionID` and answers `reply` ("always" by default).
function approveAlways(sessionID: Session.ID, input: Ask = readSrc, reply: Permission.Reply = "always") {
  return Effect.gen(function* () {
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Permission.Event.Asked.type
        ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion(sessionID, "per_first", input)).pipe(Effect.forkScoped)
    yield* service.reply({ requestID: (yield* Deferred.await(asked)).id, reply })
    yield* Fiber.join(fiber)
  })
}

function effect(sessionID: Session.ID, id: string, input: Ask = readSrc) {
  return Effect.gen(function* () {
    const service = yield* Permission.Service
    return (yield* service.ask(assertion(sessionID, id, input))).effect
  })
}

describe("explicit: always is per session", () => {
  it.effect("an always approval is never written to the database", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first)
      const { db } = yield* Database.Service
      expect(yield* db.select().from(PermissionTable).all()).toEqual([])
    }),
  )

  it.effect("it applies for the rest of the same session", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first)
      expect(yield* effect(first, "per_again")).toBe("allow")
    }),
  )

  it.effect("a later session in the same folder still asks", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* session(later)
      yield* approveAlways(first)
      expect(yield* effect(later, "per_later")).toBe("ask")
    }),
  )

  it.effect("a subagent session of the approving session shares the approval", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* session(child, first)
      yield* approveAlways(first)
      expect(yield* effect(child, "per_child")).toBe("allow")
    }),
  )

  it.effect("approvals already saved in the database are ignored", () =>
    Effect.gen(function* () {
      yield* session(first)
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["src/*"] })
      expect(yield* effect(first, "per_saved")).toBe("ask")
    }),
  )
})

describe("explicit: always covers exactly what was asked", () => {
  it.effect("not the tool's broader save pattern", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first)
      expect(yield* effect(first, "per_other", { ...readSrc, resources: ["src/other.ts"] })).toBe("ask")
    }),
  )

  it.effect("compared literally: an approved `*` in a command is not a wildcard", () =>
    Effect.gen(function* () {
      yield* session(first)
      const shell = (command: string): Ask => ({ action: "shell", resources: [command], save: ["ls *"] })
      yield* approveAlways(first, shell("ls *"))
      expect(yield* effect(first, "per_same", shell("ls *"))).toBe("allow")
      expect(yield* effect(first, "per_wider", shell("ls secret"))).toBe("ask")
    }),
  )
})

describe("explicit: an outside-folder read approval never covers a write", () => {
  const outside = (access?: "read" | "write"): Ask => ({
    action: "external_directory",
    resources: ["/outside/repo/file1"],
    save: ["/outside/repo/file1"],
    ...(access ? { metadata: { access } } : {}),
  })

  it.effect("a write to the same path still asks", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, outside("read"))
      expect(yield* effect(first, "per_read", outside("read"))).toBe("allow")
      expect(yield* effect(first, "per_write", outside("write"))).toBe("ask")
    }),
  )

  it.effect("a request that doesn't say read is treated as a write", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, outside("read"))
      expect(yield* effect(first, "per_unmarked", outside())).toBe("ask")
    }),
  )

  it.effect("a configured `<dir>/*` deny still blocks an exact file and the directory itself", () =>
    Effect.gen(function* () {
      yield* session(first)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "external_directory", resource: "/outside/*", effect: "deny" }]
        }),
      )
      expect(yield* effect(first, "per_file", outside("read"))).toBe("deny")
      expect(
        yield* effect(first, "per_dir", { ...outside("read"), resources: ["/outside/*"], save: ["/outside/*"] }),
      ).toBe("deny")
    }),
  )

  it.effect("a write approval also covers reading that path", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, outside("write"))
      expect(yield* effect(first, "per_read_after_write", outside("read"))).toBe("allow")
    }),
  )
})

describe('explicit: "Allow folder (read)" covers reading under one outside folder, nothing else', () => {
  const read = (resource: string): Ask => ({
    action: "external_directory",
    resources: [resource],
    save: [resource],
    metadata: { access: "read" },
  })
  const write = (resource: string): Ask => ({ ...read(resource), metadata: { access: "write" } })

  it.effect("reads anywhere under that folder are allowed for the session", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, read("/outside/repo/file1"), "folder")
      expect(yield* effect(first, "per_sibling", read("/outside/repo/file2"))).toBe("allow")
      expect(yield* effect(first, "per_deep", read("/outside/repo/a/b/c.txt"))).toBe("allow")
      expect(yield* effect(first, "per_search", read("/outside/repo/a/*"))).toBe("allow")
    }),
  )

  it.effect("writes in that folder, other folders and later sessions still ask", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* session(later)
      yield* approveAlways(first, read("/outside/repo/file1"), "folder")
      expect(yield* effect(first, "per_write", write("/outside/repo/file2"))).toBe("ask")
      expect(yield* effect(first, "per_parent", read("/outside/other.txt"))).toBe("ask")
      expect(yield* effect(first, "per_lookalike", read("/outside/repository/x.txt"))).toBe("ask")
      expect(yield* effect(later, "per_later_folder", read("/outside/repo/file2"))).toBe("ask")
    }),
  )

  it.effect("on a write request it only approves that once", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, write("/outside/repo/file1"), "folder")
      expect(yield* effect(first, "per_write_again", write("/outside/repo/file1"))).toBe("ask")
      expect(yield* effect(first, "per_read_after", read("/outside/repo/file2"))).toBe("ask")
    }),
  )

  it.effect("a file at the top of the filesystem never becomes an approval for everything", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, read("/file1"), "folder")
      expect(yield* effect(first, "per_anything", read("/etc/hostname"))).toBe("ask")
    }),
  )

  it.effect("it never covers a different action", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* approveAlways(first, read("/outside/repo/file1"), "folder")
      expect(
        yield* effect(first, "per_other_action", {
          action: "read",
          resources: ["/outside/repo/.env"],
          save: ["*"],
          metadata: { access: "read" },
        }),
      ).toBe("ask")
    }),
  )
})
