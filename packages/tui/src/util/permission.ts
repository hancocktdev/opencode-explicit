import { Locale } from "./locale"
import { canonicalToolName, finiteNumber, webSearchProviderLabel } from "./tool-display"

type Dict = Record<string, unknown>

export type PermissionPresentation = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  patch?: string
  file?: string
}

export type PermissionPresentationInput = {
  action: string
  resources: ReadonlyArray<unknown>
  metadata?: unknown
  input?: unknown
  toolMetadata?: unknown
}

export function permissionPresentation(
  source: PermissionPresentationInput,
  formatPath: (value: string) => string = (value) => value,
): PermissionPresentation {
  const action = canonicalToolName(source.action)
  const input = normalizeInput(action, source.input)
  const metadata = { ...dict(source.toolMetadata), ...dict(source.metadata) }
  const resources = source.resources.filter((item): item is string => typeof item === "string")

  if (action === "edit") {
    const file = text(input.path) || resources[0] || ""
    const first = dict(Array.isArray(metadata.files) ? metadata.files[0] : undefined)
    const diff = text(first.patch) || text(first.diff) || text(metadata.diff) || undefined
    return {
      icon: "→",
      title: `Edit ${formatPath(file)}`,
      lines: [],
      diff,
      patch: diff ? undefined : text(input.patchText) || undefined,
      file,
    }
  }

  if (action === "read" || action === "list") {
    const value = text(input.path) || resources[0] || ""
    const title = action === "read" ? "Read" : "List"
    return {
      icon: "→",
      title: `${title} ${formatPath(value)}`,
      lines: value ? [`Path: ${formatPath(value)}`] : [],
    }
  }

  if (action === "glob" || action === "grep") {
    const pattern = text(input.pattern) || resources[0] || ""
    const title = action === "glob" ? "Glob" : "Grep"
    return {
      icon: "✱",
      title: `${title} "${pattern}"`,
      lines: pattern ? [`Pattern: ${pattern}`] : [],
    }
  }

  if (action === "shell") {
    const command = text(input.command)
    return {
      icon: "#",
      title: "Shell command",
      lines: command ? [`$ ${command}`] : resources.map((item) => `- ${item}`),
    }
  }

  if (action === "subagent") {
    const agent = text(input.agent) || "general"
    const description = text(input.description)
    return {
      icon: "#",
      title: `${Locale.titlecase(agent)} Subagent`,
      lines: description ? [`◉ ${description}`] : [],
    }
  }

  if (action === "webfetch") {
    const url = text(input.url) || text(metadata.url)
    return {
      icon: "%",
      title: `WebFetch ${url}`,
      lines: url ? [`URL: ${url}`] : [],
    }
  }

  if (action === "websearch") {
    const query = text(input.query) || text(metadata.query)
    const title = webSearchProviderLabel(metadata.provider)
    return {
      icon: "◈",
      title: query ? `${title} "${query}"` : title,
      lines: query ? [`Query: ${query}`] : [],
    }
  }

  if (action === "lsp") {
    const file = text(input.path)
    const operation = text(input.operation) || "request"
    const line = finiteNumber(input.line)
    const character = finiteNumber(input.character)
    const position = line !== undefined && character !== undefined ? `${line}:${character}` : undefined
    return {
      icon: "→",
      title: `LSP ${operation}${file ? ` ${formatPath(file)}${position ? `:${position}` : ""}` : ""}`,
      lines: [
        ...(input.operation ? [`Operation: ${operation}`] : []),
        ...(file ? [`Path: ${formatPath(file)}`] : []),
        ...(position ? [`Position: ${position}`] : []),
      ],
    }
  }

  if (action === "external_directory") {
    // explicit: resources are the exact paths asked about; say whether it is a read or a write.
    const verb = metadata.access === "read" ? "Read outside this folder" : "Write outside this folder"
    return {
      icon: "←",
      title: resources.length === 1 ? `${verb}: ${formatPath(resources[0]!)}` : verb,
      lines: resources.map((item) => `- ${item}`),
    }
  }

  if (action === "doom_loop") {
    return {
      icon: "⟳",
      title: "Continue after repeated failures",
      lines: ["This keeps the session running despite repeated failures."],
    }
  }

  return {
    icon: "⚙",
    title: `Call tool ${source.action}`,
    lines: [`Tool: ${source.action}`],
  }
}

export function permissionAlwaysLines(input: {
  action: string
  resources: ReadonlyArray<string>
  metadata?: Record<string, unknown>
}): string[] {
  // explicit: "always" approves exactly the listed items, literally, for this session only, and is never saved
  // (core/src/permission.ts). An outside-folder read approval never covers a write.
  const kind =
    input.action === "external_directory" ? (input.metadata?.access === "read" ? " (reading only)" : " (writing)") : ""
  return [
    `This will allow ${input.action}${kind} for exactly the following, for the rest of this session only. Nothing is saved.`,
    ...input.resources.map((item) => `- ${item}`),
  ]
}

// explicit: the folders a "folder" reply would approve for reading (core/src/permission.ts `folderOf`), or
// undefined when the reply doesn't apply: only outside-folder reads, never the top of the filesystem.
export function permissionFolders(input: {
  action: string
  resources: ReadonlyArray<string>
  metadata?: Record<string, unknown>
}): string[] | undefined {
  if (input.action !== "external_directory" || input.metadata?.access !== "read") return undefined
  const folders = input.resources.map((item) =>
    item.endsWith("/*") ? item : `${item.slice(0, item.lastIndexOf("/"))}/*`,
  )
  return folders.length > 0 && folders.every((folder) => folder !== "/*") ? folders : undefined
}

export function permissionFolderLines(folders: ReadonlyArray<string>): string[] {
  return [
    "This will allow reading anything under the following, at any depth, for the rest of this session only. Writes still ask. Nothing is saved.",
    ...folders.map((folder) => `- ${folder}`),
  ]
}

export function permissionOptionLabel(option: "once" | "always" | "folder" | "reject" | "confirm" | "cancel") {
  if (option === "once") return "Allow once"
  if (option === "always") return "Allow for session"
  if (option === "folder") return "Allow folder (read)"
  if (option === "reject") return "Reject"
  if (option === "confirm") return "Confirm"
  return "Cancel"
}

function normalizeInput(action: string, value: unknown): Dict {
  const input = dict(value)
  const path = text(input.path) || text(input.filePath) || text(input.filepath)
  const agent = text(input.agent) || text(input.subagent_type)
  return {
    ...input,
    ...(["read", "edit", "list", "lsp"].includes(action) && path ? { path } : {}),
    ...(action === "subagent" && agent ? { agent } : {}),
  }
}

function dict(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Dict
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}
