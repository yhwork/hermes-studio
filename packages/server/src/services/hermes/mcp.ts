import { AgentBridgeClient } from './agent-bridge/client'
import type { McpActionResponse } from './mcp-types'
import { logger } from '../logger'

export type { McpServerEntry, McpActionResponse } from './mcp-types'

let bridgeClient: AgentBridgeClient | null = null

export function getBridgeClient(): AgentBridgeClient {
  if (!bridgeClient) {
    bridgeClient = new AgentBridgeClient()
  }
  return bridgeClient
}

/**
 * After MCP config changes (add/remove/reload), destroy all existing sessions
 * so the next message forces a fresh session with re-discovered tools.
 */
async function invalidateSessionsAfterMcpChange(client: AgentBridgeClient): Promise<void> {
  try {
    await client.destroyAll()
    logger.info('[mcp] destroyed all sessions after MCP config change — tools will be re-discovered on next message')
  } catch (err) {
    logger.warn(err, '[mcp] failed to destroy sessions after MCP change (non-fatal)')
  }
}

/**
 * Send an MCP action to the AgentBridge using typed client methods.
 */
export async function bridgeMcpAction(
  action: string,
  payload: Record<string, unknown> = {},
  profile?: string
): Promise<McpActionResponse> {
  const client = getBridgeClient()
  let raw: McpActionResponse

  switch (action) {
    case 'mcp_list':
      raw = await client.mcpList(profile)
      break
    case 'mcp_server_add': {
      const addName = String(payload.name || '')
      const addConfig = payload.config as Record<string, unknown> | undefined
      if (!addName || !addConfig) throw new Error('name and config are required')
      raw = await client.mcpAdd(addName, addConfig, profile)
      void invalidateSessionsAfterMcpChange(client)
      break
    }
    case 'mcp_server_update': {
      const updName = String(payload.name || '')
      const updConfig = payload.config as Record<string, unknown> | undefined
      if (!updName || !updConfig) throw new Error('name and config are required')
      raw = await client.mcpUpdate(updName, updConfig, profile)
      void invalidateSessionsAfterMcpChange(client)
      break
    }
    case 'mcp_server_remove': {
      const rmName = String(payload.name || '')
      if (!rmName) throw new Error('name is required')
      raw = await client.mcpRemove(rmName, profile)
      void invalidateSessionsAfterMcpChange(client)
      break
    }
    case 'mcp_server_test': {
      const testName = String(payload.name || '')
      if (!testName) throw new Error('name is required')
      raw = await client.mcpTest(testName, profile)
      break
    }
    case 'mcp_tools_list':
      raw = await client.mcpTools(payload.server as string | undefined, profile, payload.raw as boolean | undefined)
      break
    case 'mcp_reload':
      raw = await client.mcpReload(payload.server as string | undefined, profile)
      void invalidateSessionsAfterMcpChange(client)
      break
    default:
      throw new Error(`Unknown MCP action: ${action}`)
  }

  return raw
}
