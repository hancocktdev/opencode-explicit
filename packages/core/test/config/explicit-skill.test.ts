// explicit: a `skills` entry loads exactly one skill (<folder>/SKILL.md); nothing is scanned, downloaded or picked
// up from config folders.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Config } from "@opencode/core/config"
import { Directory, Document, type Entry, Info } from "@opencode/schema/config"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { tmpdir } from "../fixture/tmpdir"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(
  Layer.merge(AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node])), Watcher.testLayer),
)
const decode = Schema.decodeUnknownSync(Info)

// Records every remote skill fetch; upstream's loader uses it for URL entries.
const pulls: string[] = []
const discovery = SkillDiscovery.Service.of({
  pull: (url) => Effect.sync(() => pulls.push(url)).pipe(Effect.as([] as AbsolutePath[])),
})

async function skill(file: string, name: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}`)
}

const startService = Effect.fnUntraced(function* (entries: Entry[], directory: string) {
  const service = yield* Skill.Service
  const pluginHost = host({
    skill: { list: () => Effect.die("unused skill.list"), transform: service.transform, reload: service.reload },
  })
  yield* ConfigSkillPlugin.Plugin.effect(pluginHost).pipe(
    Effect.provide(Config.testLayer(entries, { claude: [], agents: [] })),
    Effect.provideService(SkillDiscovery.Service, discovery),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: directory })),
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
  )
  return service
})

const start = (entries: Entry[], directory: string) =>
  startService(entries, directory).pipe(
    Effect.flatMap((service) => service.list()),
    Effect.map((items) => items.map((item) => item.id).toSorted()),
  )

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const deferred = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(Skill.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(deferred, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(deferred).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

const skills = (items: string[]) => new Document({ type: "document", info: decode({ skills: items }) })

describe("explicit: skills are exactly the listed folders", () => {
  it.live("a listed folder loads only its own SKILL.md, not nested skills or other .md files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const repo = path.join(tmp.path, "reponame1")
          yield* Effect.promise(async () => {
            await skill(path.join(repo, "SKILL.md"), "top")
            await skill(path.join(repo, "notes.md"), "stray")
            await skill(path.join(repo, "a", "SKILL.md"), "depth1")
            await skill(path.join(repo, "a", "b", "c", "SKILL.md"), "depth3")
          })
          // Exactly one skill, named after its folder; nothing from notes.md or the nested folders.
          expect(yield* start([skills([repo])], tmp.path)).toEqual([Skill.ID.make("reponame1")])
        }),
      ),
    ),
  )

  it.live("a listed folder without its own SKILL.md loads nothing, whatever is below it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const repo = path.join(tmp.path, "reponame1")
          yield* Effect.promise(async () => {
            await skill(path.join(repo, "skills", "deploy", "SKILL.md"), "deploy")
            await skill(path.join(repo, "README.md"), "readme")
          })
          expect(yield* start([skills([repo])], tmp.path)).toEqual([])
        }),
      ),
    ),
  )

  it.live("URL entries are never fetched", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          pulls.length = 0
          expect(yield* start([skills(["https://example.test/skills/"])], tmp.path)).toEqual([])
          expect(pulls).toEqual([])
        }),
      ),
    ),
  )

  it.live("skill/ and skills/ in a config folder are not loaded", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = path.join(tmp.path, "config")
          yield* Effect.promise(async () => {
            await skill(path.join(config, "skills", "planted", "SKILL.md"), "planted")
            await skill(path.join(config, "skill", "other", "SKILL.md"), "other")
          })
          expect(
            yield* start([new Directory({ type: "directory", path: AbsolutePath.make(config) })], tmp.path),
          ).toEqual([])
        }),
      ),
    ),
  )

  it.live("editing a listed skill is still picked up live", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const deploy = path.join(tmp.path, "deploy")
          yield* Effect.promise(() => skill(path.join(deploy, "SKILL.md"), "initial"))
          const service = yield* startService([skills([deploy])], tmp.path)
          expect((yield* service.list()).find((item) => item.id === "deploy")?.description).toBe("initial")

          yield* Effect.promise(() => skill(path.join(deploy, "SKILL.md"), "updated"))
          yield* emitAndWait({ type: "update", path: path.join(deploy, "SKILL.md") })
          expect((yield* service.list()).find((item) => item.id === "deploy")?.description).toBe("updated")
        }),
      ),
    ),
  )
})
