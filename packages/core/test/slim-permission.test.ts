// slim: "always" approvals last for the session (and its subagent sessions) only, and are never saved.
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

function assertion(sessionID: Session.ID, id: string, resources = ["src/index.ts"]) {
  return { id: Permission.ID.create(id), sessionID, action: "read", resources, save: ["src/*"] }
}

// Asks once in `sessionID` and answers "always".
function approveAlways(sessionID: Session.ID) {
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
    const fiber = yield* service.assert(assertion(sessionID, "per_first")).pipe(Effect.forkScoped)
    yield* service.reply({ requestID: (yield* Deferred.await(asked)).id, reply: "always" })
    yield* Fiber.join(fiber)
  })
}

describe("slim: always is per session", () => {
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
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion(first, "per_again", ["src/other.ts"]))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("a later session in the same folder still asks", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* session(later)
      yield* approveAlways(first)
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion(later, "per_later"))).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("a subagent session of the approving session shares the approval", () =>
    Effect.gen(function* () {
      yield* session(first)
      yield* session(child, first)
      yield* approveAlways(first)
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion(child, "per_child"))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("approvals already saved in the database are ignored", () =>
    Effect.gen(function* () {
      yield* session(first)
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["src/*"] })
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion(first, "per_saved"))).toMatchObject({ effect: "ask" })
    }),
  )
})
