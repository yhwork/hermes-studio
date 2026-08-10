import Router from '@koa/router'
import AdmZip from 'adm-zip'
import { isAbsolute } from 'path'
import {
  createFileProvider,
  localProvider,
  isInUploadDir,
  validatePath,
  resolveHermesPath,
} from '../../services/hermes/file-provider'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'

export const xmindParseRoutes = new Router()

interface MindMapNode {
  text: string
  children: MindMapNode[]
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

/**
 * Parse XMind content.json (standard format used by modern XMind & case-demo MCP)
 */
function parseContentJson(contentJson: any[]): MindMapNode {
  if (!contentJson || !Array.isArray(contentJson) || contentJson.length === 0) {
    throw new Error('无效的 xmind 数据结构')
  }
  const sheet = contentJson[0]
  const rootTopic = sheet.rootTopic
  if (!rootTopic) {
    throw new Error('未找到根节点')
  }
  return convertXmindNode(rootTopic)
}

function convertXmindNode(xmindNode: any): MindMapNode {
  const node: MindMapNode = {
    text: xmindNode.title || '未命名节点',
    children: [],
  }
  if (xmindNode.children?.attached) {
    node.children = xmindNode.children.attached.map((child: any) => convertXmindNode(child))
  }
  return node
}

function countNodes(node: MindMapNode): number {
  let count = 1
  for (const child of node.children) count += countNodes(child)
  return count
}

function maxDepth(node: MindMapNode, current = 0): number {
  if (node.children.length === 0) return current
  return Math.max(...node.children.map(c => maxDepth(c, current + 1)))
}

function countLeaves(node: MindMapNode): number {
  if (node.children.length === 0) return 1
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0)
}

// GET /api/hermes/files/xmind-parse?path=...
xmindParseRoutes.get('/api/hermes/files/xmind-parse', async (ctx) => {
  const filePath = ctx.query.path as string | undefined

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const validPath = isAbsolute(filePath) ? validatePath(filePath) : resolveHermesPath(filePath, profile)

    let data: Buffer
    if (isInUploadDir(validPath)) {
      data = await localProvider.readFile(validPath)
    } else {
      const provider = await createFileProvider(profile)
      data = await provider.readFile(validPath)
    }

    const zip = new AdmZip(data)
    const entries = zip.getEntries()

    const jsonEntry = entries.find(e => e.entryName === 'content.json')
    if (!jsonEntry) {
      ctx.status = 400
      ctx.body = { error: '无效的 xmind 文件：未找到 content.json（仅支持新版 XMind 格式）', code: 'invalid_xmind' }
      return
    }

    const contentText = jsonEntry.getData().toString('utf-8')
    const contentJson = JSON.parse(contentText)
    const root = parseContentJson(contentJson)

    ctx.body = {
      root,
      stats: {
        totalNodes: countNodes(root),
        maxDepth: maxDepth(root),
        leafCount: countLeaves(root),
      },
    }
  } catch (err: any) {
    const code = err.code || 'unknown'
    const statusMap: Record<string, number> = {
      missing_path: 400,
      invalid_path: 400,
      not_found: 404,
      ENOENT: 404,
      file_too_large: 413,
    }
    ctx.status = statusMap[code] || 500
    ctx.body = { error: err.message, code }
  }
})
