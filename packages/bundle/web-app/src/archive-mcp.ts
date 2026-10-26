/** Load project MCP servers for Archive-mode Agents from the workspace config. */

import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u

/**
 * Load the project's `.mcp.json` and mount its servers in the Agent scope.
 * Missing config is an empty state; invalid config rejects Agent creation.
 * Failed initial connections are logged and retried by the MCP client, while
 * Agent creation continues without that server's tools until it reconnects.
 * Server commands default to the project root; configured `cwd` values
 * resolve relative to that root.
 * @param agent - Archive-mode Agent that owns the MCP clients.
 * @param signal - Agent creation cancellation signal.
 */
export async function mountArchiveMcp(agent: Agent, signal?: AbortSignal): Promise<void> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return
  const projectRoot = await findProjectRoot(cwd)
  const configPath = join(projectRoot, '.mcp.json')
  const source = await readConfig(configPath, signal)
  if (source === undefined) return

  const servers = parseServers(source, configPath, projectRoot)
  for (const server of servers) {
    if (signal !== undefined) signal.throwIfAborted()
    await agent.ctx.plugin(McpClient, server)
  }
}

/** Find the same nearest-`.git` project root used by local skill discovery. */
async function findProjectRoot(cwd: string): Promise<string> {
  const start = resolve(cwd)
  for (let current = start; ; current = dirname(current)) {
    try {
      await lstat(join(current, '.git'))
      return current
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    const parent = dirname(current)
    if (parent === current) return start
  }
}

/** Read one optional project config without converting other I/O failures to absence. */
async function readConfig(path: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    return await readFile(path, signal === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', signal })
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw new Error(`archive MCP config ${path} could not be read`, { cause: error })
  }
}

/** Parse standard `.mcp.json` declarations into the MCP client's validated configs. */
function parseServers(source: string, path: string, projectRoot: string): McpClient.Config[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`archive MCP config ${path} is not valid JSON`, { cause: error })
  }
  if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) {
    throw new Error(`archive MCP config ${path} must contain an "mcpServers" object`)
  }

  return Object.entries(parsed['mcpServers']).map(([serverName, value]) => {
    if (!SERVER_NAME.test(serverName)) {
      throw new Error(`archive MCP config ${path} has an invalid server name: ${serverName}`)
    }
    if (!isRecord(value)) throw new Error(`archive MCP config ${path} server ${serverName} must be an object`)

    if (typeof value['command'] === 'string') {
      const command = expandEnvironment(value['command'])
      if (command.trim() === '') throw new Error(`archive MCP config ${path} server ${serverName} has an empty command`)
      const cwd = value['cwd'] === undefined
        ? projectRoot
        : typeof value['cwd'] === 'string'
          ? resolve(projectRoot, expandEnvironment(value['cwd']))
          : invalidField(path, serverName, 'cwd', 'a string')
      return clientConfig(path, serverName, () => McpClient.Config({
        transport: 'stdio',
        serverName,
        command,
        args: strings(value['args'], path, serverName, 'args'),
        env: stringMap(value['env'], path, serverName, 'env'),
        cwd,
        failOnStartupError: false,
      }))
    }

    if (value['type'] === 'http') {
      const url = typeof value['url'] === 'string' ? expandEnvironment(value['url']) : invalidField(path, serverName, 'url', 'a string')
      assertHttpUrl(url, path, serverName)
      return clientConfig(path, serverName, () => McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url,
        headers: stringMap(value['headers'], path, serverName, 'headers'),
        failOnStartupError: false,
      }))
    }

    throw new Error(`archive MCP config ${path} server ${serverName} must define "command" or use type "http"`)
  })
}

/** Convert an optional string list and expand `${NAME}` and `${NAME:-fallback}` values. */
function strings(value: unknown, path: string, serverName: string, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return invalidField(path, serverName, field, 'an array of strings')
  }
  return value.map(expandEnvironment)
}

/** Convert an optional string dictionary without accepting untrusted non-string values. */
function stringMap(value: unknown, path: string, serverName: string, field: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) return invalidField(path, serverName, field, 'an object of strings')
  const result = Object.create(null) as Record<string, string>
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return invalidField(path, serverName, `${field}.${key}`, 'a string')
    result[key] = expandEnvironment(entry)
  }
  return result
}

/** Replace standard environment references without invoking a shell. */
function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu,
    (_match, name: string, fallback: string | undefined) => process.env[name] ?? fallback ?? '')
}

/** Ensure HTTP entries use the transport supported by the MCP client. */
function assertHttpUrl(url: string, path: string, serverName: string): void {
  try {
    const protocol = new URL(url).protocol
    if (protocol === 'http:' || protocol === 'https:') return
  } catch (error) {
    throw new Error(`archive MCP config ${path} server ${serverName} has an invalid HTTP URL`, { cause: error })
  }
  throw new Error(`archive MCP config ${path} server ${serverName} URL must use HTTP or HTTPS`)
}

/** Parse one MCP config with its path and server name attached to validation failures. */
function clientConfig(path: string, serverName: string, parse: () => McpClient.Config): McpClient.Config {
  try {
    return parse()
  } catch (error) {
    throw new Error(`archive MCP config ${path} server ${serverName} is invalid`, { cause: error })
  }
}

/** Reject one malformed project MCP field. */
function invalidField(path: string, serverName: string, field: string, expected: string): never {
  throw new Error(`archive MCP config ${path} server ${serverName} field ${field} must be ${expected}`)
}

/** Whether an untrusted parsed value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an errno code without trusting an arbitrary caught value. */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
