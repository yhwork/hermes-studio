/**
 * Knowledge base query tool for the Ekko agent runtime.
 *
 * Allows the agent to search one or more knowledge bases for relevant
 * information using keyword, semantic, or hybrid retrieval.
 *
 * The tool calls the server's REST API to perform the query, since the
 * knowledge base data lives in the server's SQLite database.
 */

import type {
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from './types'
import type { QueryKnowledgeBaseInput, RetrievalMode } from '../knowledge/types'

/** Configuration for connecting to the Hermes server. */
export interface KnowledgeBaseToolConfig {
  /** Base URL of the Hermes server (e.g. "http://127.0.0.1:8648"). */
  serverUrl: string
  /** Optional auth token for the server API. */
  authToken?: string
}

export class QueryKnowledgeBaseTool implements AgentTool<QueryKnowledgeBaseInput> {
  private readonly config: KnowledgeBaseToolConfig

  constructor(config: KnowledgeBaseToolConfig) {
    this.config = config
  }

  readonly definition = {
    name: 'query_knowledge_base',
    description: [
      'Search one or more knowledge bases for information relevant to a query.',
      'Returns the most relevant text chunks along with their source document metadata.',
      'Use this tool when you need to look up facts, procedures, or reference material stored in knowledge bases.',
      'If no knowledge_base_ids are provided, all available knowledge bases will be searched.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query text. Use natural language or keywords.',
        },
        knowledge_base_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of knowledge base IDs to search within. If omitted, all knowledge bases are searched.',
        },
        mode: {
          type: 'string',
          enum: ['keyword', 'semantic', 'hybrid'],
          description: 'Retrieval mode. "keyword" uses full-text search; "semantic" uses vector similarity (reserved); "hybrid" combines both. Default: keyword.',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return. Default: 5.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }

  async execute(input: QueryKnowledgeBaseInput, context?: AgentToolContext): Promise<AgentToolResult> {
    const query = String(input.query || '').trim()
    if (!query) return failure('query_knowledge_base requires a non-empty query.')

    const knowledgeBaseIds = Array.isArray(input.knowledge_base_ids)
      ? input.knowledge_base_ids.filter((id: any) => typeof id === 'string')
      : []

    const mode: RetrievalMode = input.mode === 'semantic' || input.mode === 'hybrid'
      ? input.mode
      : 'keyword'

    const topK = typeof input.top_k === 'number' && input.top_k > 0
      ? Math.min(input.top_k, 20)
      : 5

    try {
      const url = `${this.config.serverUrl.replace(/\/+$/, '')}/api/hermes/knowledge-bases/query`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.config.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          knowledgeBaseIds,
          query,
          mode,
          topK,
          minScore: 0.1,
        }),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return failure(`Knowledge base query failed (HTTP ${response.status}): ${text}`)
      }

      const data = await response.json() as { results: any[] }
      if (!data.results || data.results.length === 0) {
        return {
          ok: true,
          content: 'No relevant information found in the knowledge base(s) for this query.',
        }
      }

      // Format results for the model
      const formatted = data.results.map((r: any, i: number) => {
        const doc = r.document ?? {}
        const chunk = r.chunk ?? {}
        return [
          `[${i + 1}] Score: ${typeof r.score === 'number' ? r.score.toFixed(3) : 'N/A'}`,
          `Source: ${doc.title || 'Untitled'} (${doc.mimeType || 'unknown'})`,
          `Document ID: ${doc.id || 'N/A'}`,
          chunk.content || '',
        ].join('\n')
      }).join('\n\n---\n\n')

      return {
        ok: true,
        content: formatted,
        data: data.results,
      }
    } catch (err: any) {
      return failure(`Knowledge base query error: ${err.message}`)
    }
  }
}

export function createKnowledgeBaseTools(config: KnowledgeBaseToolConfig): AgentTool[] {
  return [new QueryKnowledgeBaseTool(config)]
}

function failure(message: string): AgentToolResult {
  return { ok: false, content: message, error: message }
}
