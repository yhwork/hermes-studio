import type { Context } from 'koa'
import { randomBytes } from 'crypto'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import {
  createKnowledgeBase,
  listKnowledgeBases,
  getKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  addDocument,
  listDocuments,
  getDocument,
  getDocumentChunks,
  deleteDocument,
  queryKnowledgeBases,
} from '../../db/hermes/knowledge-base-store'
import { DEFAULT_CHUNK_STRATEGY, type ChunkStrategy } from '../../db/hermes/knowledge-base-store'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getProfileUploadDir } from '../../services/hermes/upload-paths'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

function getProfile(ctx: Context): string {
  return (ctx.state as any)?.profile?.name || ''
}

// ─── Knowledge Base CRUD ────────────────────────────────────────────

export async function listKbs(ctx: Context) {
  const profileId = getProfile(ctx)
  ctx.body = listKnowledgeBases(profileId || undefined)
}

export async function getKb(ctx: Context) {
  const id = ctx.params.id as string
  if (!id) { ctx.status = 400; ctx.body = { error: 'Missing id' }; return }
  const kb = getKnowledgeBase(id)
  if (!kb) { ctx.status = 404; ctx.body = { error: 'Knowledge base not found' }; return }
  ctx.body = kb
}

export async function createKb(ctx: Context) {
  const { name, description, chunkStrategy } = (ctx.request.body || {}) as Record<string, any>
  if (!name || typeof name !== 'string' || !name.trim()) {
    ctx.status = 400
    ctx.body = { error: 'name is required' }
    return
  }
  const strategy: ChunkStrategy = {
    ...DEFAULT_CHUNK_STRATEGY,
    ...(chunkStrategy || {}),
  }
  const kb = createKnowledgeBase(name.trim(), getProfile(ctx), description ?? '', strategy)
  ctx.status = 201
  ctx.body = kb
}

export async function updateKb(ctx: Context) {
  const id = ctx.params.id as string
  if (!id) { ctx.status = 400; ctx.body = { error: 'Missing id' }; return }
  const { name, description, chunkStrategy } = (ctx.request.body || {}) as Record<string, any>
  const kb = updateKnowledgeBase(id, {
    ...(name ? { name: String(name).trim() } : {}),
    ...(description !== undefined ? { description: String(description) } : {}),
    ...(chunkStrategy ? { chunkStrategy: { ...DEFAULT_CHUNK_STRATEGY, ...chunkStrategy } } : {}),
  })
  if (!kb) { ctx.status = 404; ctx.body = { error: 'Knowledge base not found' }; return }
  ctx.body = kb
}

export async function deleteKb(ctx: Context) {
  const id = ctx.params.id as string
  if (!id) { ctx.status = 400; ctx.body = { error: 'Missing id' }; return }
  if (!deleteKnowledgeBase(id)) { ctx.status = 404; ctx.body = { error: 'Knowledge base not found' }; return }
  ctx.body = { success: true }
}

// ─── Document CRUD ──────────────────────────────────────────────────

export async function listDocs(ctx: Context) {
  const kbId = ctx.params.kbId as string
  if (!kbId) { ctx.status = 400; ctx.body = { error: 'Missing kbId' }; return }
  ctx.body = listDocuments(kbId)
}

export async function addDoc(ctx: Context) {
  const kbId = ctx.params.kbId as string
  if (!kbId) { ctx.status = 400; ctx.body = { error: 'Missing kbId' }; return }
  const kb = getKnowledgeBase(kbId)
  if (!kb) { ctx.status = 404; ctx.body = { error: 'Knowledge base not found' }; return }

  const { title, content, mimeType, sourceUrl } = (ctx.request.body || {}) as Record<string, any>
  if (!title || typeof title !== 'string' || !title.trim()) {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  if (!content || typeof content !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'content is required' }
    return
  }

  const doc = addDocument(
    kbId,
    title.trim(),
    content,
    mimeType || 'text/plain',
    sourceUrl,
  )
  ctx.status = 201
  ctx.body = doc
}

export async function getDoc(ctx: Context) {
  const docId = ctx.params.docId as string
  if (!docId) { ctx.status = 400; ctx.body = { error: 'Missing docId' }; return }
  const doc = getDocument(docId)
  if (!doc) { ctx.status = 404; ctx.body = { error: 'Document not found' }; return }
  ctx.body = doc
}

export async function deleteDoc(ctx: Context) {
  const docId = ctx.params.docId as string
  if (!docId) { ctx.status = 400; ctx.body = { error: 'Missing docId' }; return }
  if (!deleteDocument(docId)) { ctx.status = 404; ctx.body = { error: 'Document not found' }; return }
  ctx.body = { success: true }
}

// ─── File Upload ────────────────────────────────────────────────────

export async function uploadDoc(ctx: Context) {
  const kbId = ctx.params.kbId as string
  if (!kbId) { ctx.status = 400; ctx.body = { error: 'Missing kbId' }; return }
  const kb = getKnowledgeBase(kbId)
  if (!kb) { ctx.status = 404; ctx.body = { error: 'Knowledge base not found' }; return }

  const contentType = ctx.headers['content-type'] || ''
  const isMultipart = contentType.includes('multipart/form-data')

  if (isMultipart) {
    // Handle multipart file upload
    const raw = ctx.request.rawBody || (ctx.req as any).rawBody
    if (!raw || !Buffer.isBuffer(raw)) {
      // Fallback: read body from the request stream
      ctx.status = 400
      ctx.body = { error: 'No file data received' }
      return
    }

    if (raw.length > MAX_UPLOAD_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }
      return
    }

    const boundary = parseMultipartBoundary(contentType)
    if (!boundary) {
      ctx.status = 400
      ctx.body = { error: 'Invalid multipart boundary' }
      return
    }

    const parts = splitMultipart(raw, boundary)
    if (parts.length === 0) {
      ctx.status = 400
      ctx.body = { error: 'No file part found in upload' }
      return
    }

    // Find the first part with a filename
    let fileContent = ''
    let fileName = 'upload'
    let mimeType = 'text/plain'

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd === -1) continue
      const header = part.subarray(0, headerEnd).toString('utf-8')
      const name = parseMultipartFilename(header)
      if (!name) continue

      fileName = name
      const body = part.subarray(headerEnd + 4)
      // Remove trailing \r\n
      const trimmed = body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a
        ? body.subarray(0, body.length - 2)
        : body

      // Try to decode as UTF-8 text; fall back to base64 for binary
      const isText = !header.includes('content-type:') ||
        /text\/|application\/(json|xml|javascript|yaml|x-yaml)/i.test(header) ||
        /charset=utf-8/i.test(header)

      if (isText) {
        try {
          fileContent = trimmed.toString('utf-8')
          mimeType = header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'text/plain'
        } catch {
          fileContent = trimmed.toString('base64')
          mimeType = 'application/octet-stream'
        }
      } else {
        fileContent = trimmed.toString('base64')
        mimeType = header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream'
      }
      break
    }

    if (!fileContent) {
      ctx.status = 400
      ctx.body = { error: 'Could not parse uploaded file' }
      return
    }

    const doc = addDocument(kbId, fileName, fileContent, mimeType)
    ctx.status = 201
    ctx.body = doc
  } else {
    // Handle JSON body upload
    const { title, content, mimeType, sourceUrl } = (ctx.request.body || {}) as Record<string, any>
    if (!title || typeof title !== 'string' || !title.trim()) {
      ctx.status = 400
      ctx.body = { error: 'title is required' }
      return
    }
    if (!content || typeof content !== 'string') {
      ctx.status = 400
      ctx.body = { error: 'content is required' }
      return
    }

    const doc = addDocument(kbId, title.trim(), content, mimeType || 'text/plain', sourceUrl)
    ctx.status = 201
    ctx.body = doc
  }
}

// ─── Document Content ───────────────────────────────────────────────

export async function getDocContent(ctx: Context) {
  const docId = ctx.params.docId as string
  if (!docId) { ctx.status = 400; ctx.body = { error: 'Missing docId' }; return }
  const doc = getDocument(docId)
  if (!doc) { ctx.status = 404; ctx.body = { error: 'Document not found' }; return }

  const chunks = getDocumentChunks(docId)
  ctx.body = {
    document: doc,
    chunks,
    fullContent: chunks.map(c => c.content).join('\n\n'),
  }
}

// ─── Query ──────────────────────────────────────────────────────────

export async function query(ctx: Context) {
  const { knowledgeBaseIds, query: queryText, mode, topK, minScore } = (ctx.request.body || {}) as Record<string, any>
  if (!queryText || typeof queryText !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'query is required' }
    return
  }
  const ids = Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds.filter((id: any) => typeof id === 'string') : []
  const results = queryKnowledgeBases({
    knowledgeBaseIds: ids,
    query: queryText,
    mode: mode || 'keyword',
    topK: typeof topK === 'number' ? topK : 5,
    minScore: typeof minScore === 'number' ? minScore : 0.1,
  })
  ctx.body = { results }
}
