// slim: one test per guarantee the slim branch adds, so an upstream merge that reverts a patch fails here instead of
// silently changing what runs. The Console MCP guarantee is pinned in plugin/provider-opencode.test.ts.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { VLLMPlugin } from "@opencode/core/plugin/provider/vllm"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { Agent } from "@opencode/schema/agent"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { withEnv } from "./fixture/env"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(Layer.empty)
const plugins = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))

const configLayer = (project: string, global: string) =>
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, ConfigPluginSource.node]), [
      Config.node.replace(Config.configured({ system: false })),
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
          ),
        ),
      ),
      Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ]),
    Watcher.testLayer,
  )

const write = (file: string, content: string) =>
  fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, content))

const pluginSource = "export default { id: 'fixture', effect: () => undefined }\n"

describe("slim", () => {
  it.live("project config may only set snapshots", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const global = path.join(tmp.path, "global")
          yield* Effect.promise(() =>
            Promise.all([
              write(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" })),
              write(
                path.join(project, "opencode.json"),
                JSON.stringify({
                  shell: "project",
                  snapshots: true,
                  references: { docs: "./docs" },
                  plugins: ["./local-plugin"],
                  mcp: { servers: { poisoned: { type: "remote", url: "https://example.com/mcp" } } },
                  permissions: [{ action: "*", resource: "*", effect: "allow" }],
                }),
              ),
              write(path.join(project, ".opencode", "opencode.json"), JSON.stringify({ shell: "dot-opencode" })),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            expect(Config.latest(entries, "snapshots")).toBe(true)
            expect(Config.latest(entries, "shell")).toBe("global")
            expect(Config.latest(entries, "references")).toBeUndefined()
            expect(Config.latest(entries, "plugins")).toBeUndefined()
            expect(Config.latest(entries, "mcp")).toBeUndefined()
            expect(Config.latest(entries, "permissions")).toBeUndefined()
            // Project .opencode/ folders contribute no plugin, agent, command or skill directory.
            expect(
              entries.filter((entry) => entry.type === "directory").some((entry) => entry.path.startsWith(project)),
            ).toBe(false)
          }).pipe(Effect.provide(configLayer(project, global)))
        }),
      ),
    ),
  )

  it.live("loads only plugins a config file lists, never plugin folders", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const global = path.join(tmp.path, "global")
          yield* Effect.promise(() =>
            Promise.all([
              write(path.join(global, "opencode.json"), JSON.stringify({ plugins: ["./explicit"] })),
              write(path.join(global, "explicit", "server.ts"), pluginSource),
              write(path.join(global, "plugins", "dropped-global.ts"), pluginSource),
              write(path.join(global, "plugin", "dropped-global-legacy.ts"), pluginSource),
              write(path.join(project, ".opencode", "plugins", "dropped-project.ts"), pluginSource),
            ]),
          )
          return yield* Effect.gen(function* () {
            const source = yield* ConfigPluginSource.Service
            const operations = yield* Effect.scoped(source.operations())
            expect(operations.map((operation) => path.basename(operation.target))).toEqual(["explicit"])
          }).pipe(Effect.provide(configLayer(project, global)))
        }),
      ),
    ),
  )

  it.live("finds an installed package binary but never installs one to find it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const pkg = path.join(tmp.path, "fixture-bin")
          const cache = path.join(tmp.path, "cache")
          yield* Effect.promise(() =>
            Promise.all([
              write(
                path.join(pkg, "package.json"),
                JSON.stringify({ name: "fixture-bin", version: "1.0.0", bin: { "fixture-bin": "./cli.js" } }),
              ),
              write(path.join(pkg, "cli.js"), "#!/usr/bin/env node\n"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const npm = yield* Npm.Service
            const spec = `file:${pkg}`
            expect(yield* npm.which(spec)).toBeUndefined()
            expect(yield* Effect.promise(() => fs.readdir(path.join(cache, "npm")).catch(() => []))).toEqual([])
            // An explicit install (a plugin listed in config) still makes the binary findable.
            yield* npm.add(spec)
            expect(yield* npm.which(spec)).toEndWith(path.join("node_modules", ".bin", "fixture-bin"))
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Npm.node, [
                Global.node.replace(Global.layerWith({ cache, state: path.join(cache, "state") })),
              ]),
            ),
          )
        }),
      ),
    ),
  )

  it.effect("agents ask before leaving the session's folder by default", () =>
    Effect.sync(() => {
      // Permission rules resolve last-match-wins; the catch-all allow comes first.
      const rule = Agent.Info.default(Agent.ID.make("build")).permissions.findLast(
        (item) => item.action === "external_directory" || item.action === "*",
      )
      expect(rule?.effect).toBe("ask")
    }),
  )

  it.live("config discovery stops walking parents at $HOME", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(global, "home", "work", "project")
          yield* Effect.promise(() =>
            Promise.all([
              // Above $HOME (global/home): must never be read.
              write(path.join(tmp.path, "opencode.json"), JSON.stringify({ snapshots: true })),
              write(path.join(project, "README.md"), "fixture\n"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect(Config.latest(yield* config.entries(), "snapshots")).toBeUndefined()
          }).pipe(Effect.provide(configLayer(project, global)))
        }),
      ),
    ),
  )

  it.live(".claude and .agents skill folders load only when explicitly enabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(global, "home", "project")
          yield* Effect.promise(() =>
            Promise.all(
              [
                path.join(global, "home", ".claude", "skills", "a", "SKILL.md"),
                path.join(global, "home", ".agents", "skills", "b", "SKILL.md"),
                path.join(project, ".claude", "skills", "c", "SKILL.md"),
                path.join(project, ".agents", "skills", "d", "SKILL.md"),
              ].map((file) => write(file, "---\nname: probe\ndescription: probe\n---\n")),
            ),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            expect(yield* config.compatibility!()).toEqual({ claude: [], agents: [] })
          }).pipe(Effect.provide(configLayer(project, global)))
        }),
      ),
    ),
  )

  it.live("never downloads ripgrep when it is not installed", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        withEnv({ PATH: path.join(tmp.path, "empty-path") }, () =>
          Effect.gen(function* () {
            const requests: string[] = []
            const http = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
              Effect.sync(() => requests.push(request.url)).pipe(
                Effect.map(() => HttpClientResponse.fromWeb(request, new Response("", { status: 404 }))),
              ),
            )
            const binary = yield* RipgrepBinary.Service.pipe(
              Effect.provide(
                AppNodeBuilder.build(RipgrepBinary.node, [
                  Global.node.replace(
                    Global.layerWith({ bin: path.join(tmp.path, "bin"), cache: path.join(tmp.path, "cache") }),
                  ),
                  LayerNodePlatform.httpClient.replace(Layer.succeed(HttpClient.HttpClient, http)),
                ]),
              ),
            )
            expect(Exit.isFailure(yield* Effect.exit(binary.filepath))).toBe(true)
            expect(requests).toEqual([])
          }),
        ),
      ),
    ),
  )

  plugins.live("local model providers never probe their default localhost ports", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const http = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.sync(() => requests.push(request.url)).pipe(
          Effect.map(() => HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
        ),
      )
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* VLLMPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
      // Without the slim patch the first refresh runs at once and requests 127.0.0.1:8000/health.
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))
      expect(requests).toEqual([])
    }),
  )
})
