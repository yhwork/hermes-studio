/**
 * Knowledge base storage layer using the server's SQLite database
 * (with JSON fallback for Node < 22.5).
 *
 * Tables:
 *   knowledge_bases       — metadata for each knowledge base
 *   knowledge_documents   — source documents within a knowledge base
 *   knowledge_chunks      — text chunks extracted from documents (FTS-indexed when available)
 *
 * Types are defined inline here to avoid cross-package imports that break
 * ts-node's module resolution. The canonical type definitions live in
 * packages/ekko-agent/src/knowledge/types.ts and must be kept in sync.
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import {
  getDb,
  jsonGet,
  jsonSet,
  jsonGetAll,
  jsonDelete,
} from '../index'

// ─── Inline types (synced with ekko-agent/src/knowledge/types.ts) ───

export type ChunkStrategyType = 'fixed' | 'sentence' | 'paragraph'

export interface ChunkStrategy {
  type: ChunkStrategyType
  chunkSize: number
  overlap: number
  minChunkSize: number
}

export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = {
  type: 'fixed',
  chunkSize: 512,
  overlap: 64,
  minChunkSize: 100,
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  profileId: string
  chunkStrategy: ChunkStrategy
  embeddingModel?: string
  documentCount: number
  chunkCount: number
  totalSizeBytes: number
  createdAt: string
  updatedAt: string
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'error' | 'deleted'

export interface KnowledgeDocument {
  id: string
  knowledgeBaseId: string
  title: string
  mimeType: string
  status: DocumentStatus
  errorMessage?: string
  contentHash: string
  sourceUrl?: string
  sizeBytes: number
  chunkCount: number
  createdAt: string
  updatedAt: string
}

export interface DocumentChunk {
  id: string
  documentId: string
  knowledgeBaseId: string
  chunkIndex: number
  content: string
  startOffset: number
  charLength: number
  createdAt: string
}

export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid'

export interface RetrievalRequest {
  knowledgeBaseIds: string[]
  query: string
  mode: RetrievalMode
  topK: number
  minScore: number
}

export interface RetrievalResult {
  chunk: DocumentChunk
  score: number
  document: { id: string; title: string; mimeType: string }
}

// ─── FTS5 availability ──────────────────────────────────────────────

let ftsEnabled = false

// ─── Schema helpers ─────────────────────────────────────────────────

const KB_SCHEMA: Record<string, string> = {
  id:               'TEXT PRIMARY KEY',
  name:             'TEXT NOT NULL',
  description:      'TEXT NOT NULL DEFAULT ""',
  profile_id:       'TEXT NOT NULL DEFAULT ""',
  chunk_strategy:   'TEXT NOT NULL',            // JSON
  embedding_model:  'TEXT',
  document_count:   'INTEGER NOT NULL DEFAULT 0',
  chunk_count:      'INTEGER NOT NULL DEFAULT 0',
  total_size_bytes: 'INTEGER NOT NULL DEFAULT 0',
  created_at:       'TEXT NOT NULL',
  updated_at:       'TEXT NOT NULL',
}

const DOC_SCHEMA: Record<string, string> = {
  id:               'TEXT PRIMARY KEY',
  knowledge_base_id:'TEXT NOT NULL',
  title:            'TEXT NOT NULL',
  mime_type:        'TEXT NOT NULL DEFAULT "text/plain"',
  status:           'TEXT NOT NULL DEFAULT "pending"',
  error_message:    'TEXT',
  content_hash:     'TEXT NOT NULL',
  source_url:       'TEXT',
  size_bytes:       'INTEGER NOT NULL DEFAULT 0',
  chunk_count:      'INTEGER NOT NULL DEFAULT 0',
  created_at:       'TEXT NOT NULL',
  updated_at:       'TEXT NOT NULL',
}

const CHUNK_SCHEMA: Record<string, string> = {
  id:               'TEXT PRIMARY KEY',
  document_id:      'TEXT NOT NULL',
  knowledge_base_id:'TEXT NOT NULL',
  chunk_index:      'INTEGER NOT NULL',
  content:          'TEXT NOT NULL',
  start_offset:     'INTEGER NOT NULL DEFAULT 0',
  char_length:      'INTEGER NOT NULL',
  created_at:       'TEXT NOT NULL',
}

const KB_INDEXES = [
  'CREATE INDEX IF NOT EXISTS kb_profile ON knowledge_bases (profile_id)',
]

const DOC_INDEXES = [
  'CREATE INDEX IF NOT EXISTS doc_kb ON knowledge_documents (knowledge_base_id)',
  'CREATE INDEX IF NOT EXISTS doc_status ON knowledge_documents (status)',
  'CREATE INDEX IF NOT EXISTS doc_hash ON knowledge_documents (content_hash)',
]

const CHUNK_INDEXES = [
  'CREATE INDEX IF NOT EXISTS chunk_doc ON knowledge_chunks (document_id)',
  'CREATE INDEX IF NOT EXISTS chunk_kb ON knowledge_chunks (knowledge_base_id)',
]

// ─── Table init ─────────────────────────────────────────────────────

export function initKnowledgeBaseTables(): void {
  const db = getDb()
  if (!db) return // JSON fallback — tables are virtual

  syncTable(db, 'knowledge_bases', KB_SCHEMA, { indexes: KB_INDEXES })
  syncTable(db, 'knowledge_documents', DOC_SCHEMA, { indexes: DOC_INDEXES })
  syncTable(db, 'knowledge_chunks', CHUNK_SCHEMA, { indexes: CHUNK_INDEXES })

  // FTS5 virtual table — best-effort: node:sqlite may not include FTS5.
  // When unavailable, queries fall back to LIKE-based search.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
      USING fts5(content, content='knowledge_chunks', content_rowid='rowid')
    `)
    // Trigger: auto-sync inserts into FTS
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chunk_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `)
    // Trigger: auto-sync deletes from FTS
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chunk_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END
    `)
    // Trigger: auto-sync updates into FTS
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chunk_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `)
    ftsEnabled = true
  } catch {
    // FTS5 not available — queries will use LIKE-based fallback
    ftsEnabled = false
  }
}

function syncTable(
  db: import('node:sqlite').DatabaseSync,
  tableName: string,
  schema: Record<string, string>,
  options: { indexes?: string[] } = {},
): void {
  const cols = Object.entries(schema).map(([name, def]) => `${name} ${def}`).join(', ')
  db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`)
  // Additive-only column migration
  addMissingSafeColumns(db, tableName, schema)
  for (const idx of options.indexes ?? []) {
    db.exec(idx)
  }
}

function addMissingSafeColumns(
  db: import('node:sqlite').DatabaseSync,
  tableName: string,
  schema: Record<string, string>,
): void {
  // Collect existing column names
  const existing = new Set<string>()
  const info = db.prepare(`PRAGMA table_info(${tableName})`)
  for (const row of info.all() as any[]) {
    existing.add(row.name)
  }
  // Add columns that don't exist yet, skipping PRIMARY KEY and NOT NULL without DEFAULT
  for (const [name, def] of Object.entries(schema)) {
    if (existing.has(name)) continue
    if (def.includes('PRIMARY KEY')) continue
    if (def.includes('NOT NULL') && !def.includes('DEFAULT')) continue
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${def}`)
  }
}

// ─── Knowledge Base CRUD ────────────────────────────────────────────

export function createKnowledgeBase(
  name: string,
  profileId: string = '',
  description: string = '',
  chunkStrategy: ChunkStrategy = DEFAULT_CHUNK_STRATEGY,
): KnowledgeBase {
  const id = randomUUID()
  const now = new Date().toISOString()
  const kb: KnowledgeBase = {
    id,
    name,
    description,
    profileId,
    chunkStrategy,
    documentCount: 0,
    chunkCount: 0,
    totalSizeBytes: 0,
    createdAt: now,
    updatedAt: now,
  }

  const db = getDb()
  if (db) {
    db.prepare(`
      INSERT INTO knowledge_bases
        (id, name, description, profile_id, chunk_strategy, embedding_model,
         document_count, chunk_count, total_size_bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, description, profileId,
      JSON.stringify(chunkStrategy), kb.embeddingModel ?? null,
      0, 0, 0, now, now,
    )
  } else {
    jsonSet('knowledge_bases', id, kbRowToJson(kb))
  }

  return kb
}

export function listKnowledgeBases(profileId?: string): KnowledgeBase[] {
  const db = getDb()
  if (db) {
    const stmt = profileId
      ? db.prepare('SELECT * FROM knowledge_bases WHERE profile_id = ? ORDER BY created_at DESC')
      : db.prepare('SELECT * FROM knowledge_bases ORDER BY created_at DESC')
    const rows = profileId ? stmt.all(profileId) : stmt.all()
    return (rows as any[]).map(jsonToKb)
  }
  // JSON fallback
  const all = jsonGetAll('knowledge_bases')
  return Object.values(all)
    .map(jsonToKb)
    .filter(kb => !profileId || kb.profileId === profileId)
}

export function getKnowledgeBase(id: string): KnowledgeBase | undefined {
  const db = getDb()
  if (db) {
    const row = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as any
    return row ? jsonToKb(row) : undefined
  }
  const data = jsonGet('knowledge_bases', id)
  return data ? jsonToKb(data) : undefined
}

export function updateKnowledgeBase(
  id: string,
  updates: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'chunkStrategy'>>,
): KnowledgeBase | undefined {
  const existing = getKnowledgeBase(id)
  if (!existing) return undefined

  const merged = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  }

  const db = getDb()
  if (db) {
    db.prepare(`
      UPDATE knowledge_bases
      SET name = ?, description = ?, chunk_strategy = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.name, merged.description,
      JSON.stringify(merged.chunkStrategy), merged.updatedAt, id,
    )
  } else {
    jsonSet('knowledge_bases', id, kbRowToJson(merged))
  }

  return merged
}

export function deleteKnowledgeBase(id: string): boolean {
  const db = getDb()
  if (db) {
    // Delete chunks, documents, then the knowledge base itself
    db.prepare('DELETE FROM knowledge_chunks WHERE knowledge_base_id = ?').run(id)
    db.prepare('DELETE FROM knowledge_documents WHERE knowledge_base_id = ?').run(id)
    const result = db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
    return (result as any).changes > 0
  }
  // JSON fallback — need to clean up related data too
  const allDocs = jsonGetAll('knowledge_documents')
  for (const [docId, doc] of Object.entries(allDocs)) {
    if ((doc as any).knowledge_base_id === id || (doc as any).knowledgeBaseId === id) {
      jsonDelete('knowledge_documents', docId)
    }
  }
  const allChunks = jsonGetAll('knowledge_chunks')
  for (const [chunkId, chunk] of Object.entries(allChunks)) {
    if ((chunk as any).knowledge_base_id === id || (chunk as any).knowledgeBaseId === id) {
      jsonDelete('knowledge_chunks', chunkId)
    }
  }
  return jsonDelete('knowledge_bases', id) !== undefined
}

// ─── Document CRUD ──────────────────────────────────────────────────

export function addDocument(
  knowledgeBaseId: string,
  title: string,
  content: string,
  mimeType: string = 'text/plain',
  sourceUrl?: string,
): KnowledgeDocument {
  const id = randomUUID()
  const now = new Date().toISOString()
  const contentHash = sha256(content)
  const sizeBytes = Buffer.byteLength(content, 'utf-8')

  const doc: KnowledgeDocument = {
    id,
    knowledgeBaseId,
    title,
    mimeType,
    status: 'pending',
    contentHash,
    sourceUrl,
    sizeBytes,
    chunkCount: 0,
    createdAt: now,
    updatedAt: now,
  }

  const db = getDb()
  if (db) {
    db.prepare(`
      INSERT INTO knowledge_documents
        (id, knowledge_base_id, title, mime_type, status, error_message,
         content_hash, source_url, size_bytes, chunk_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, knowledgeBaseId, title, mimeType, 'pending', null,
      contentHash, sourceUrl ?? null, sizeBytes, 0, now, now,
    )
  } else {
    jsonSet('knowledge_documents', id, docRowToJson(doc))
  }

  // Process document into chunks
  try {
    const kb = getKnowledgeBase(knowledgeBaseId)
    if (!kb) throw new Error(`Knowledge base ${knowledgeBaseId} not found`)
    const strategy = kb.chunkStrategy
    const chunks = chunkText(content, strategy)

    for (const chunk of chunks) {
      insertChunk(db, {
        id: randomUUID(),
        documentId: id,
        knowledgeBaseId,
        chunkIndex: chunk.index,
        content: chunk.text,
        startOffset: chunk.startOffset,
        charLength: chunk.text.length,
        createdAt: now,
      })
    }

    // Update document status and chunk count
    updateDocumentStatus(id, 'ready', undefined, chunks.length)
    // Update knowledge base counters
    incrementKbCounters(knowledgeBaseId, 1, chunks.length, sizeBytes)
    // Update the returned doc object
    doc.status = 'ready'
    doc.chunkCount = chunks.length
  } catch (err: any) {
    updateDocumentStatus(id, 'error', err.message)
    doc.status = 'error'
    doc.errorMessage = err.message
  }

  return doc
}

export function listDocuments(knowledgeBaseId: string): KnowledgeDocument[] {
  const db = getDb()
  if (db) {
    const rows = db.prepare(
      'SELECT * FROM knowledge_documents WHERE knowledge_base_id = ? ORDER BY created_at DESC',
    ).all(knowledgeBaseId) as any[]
    return rows.map(jsonToDoc)
  }
  const all = jsonGetAll('knowledge_documents')
  return Object.values(all)
    .map(jsonToDoc)
    .filter(d => d.knowledgeBaseId === knowledgeBaseId)
}

export function getDocument(id: string): KnowledgeDocument | undefined {
  const db = getDb()
  if (db) {
    const row = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(id) as any
    return row ? jsonToDoc(row) : undefined
  }
  const data = jsonGet('knowledge_documents', id)
  return data ? jsonToDoc(data) : undefined
}

export function getDocumentChunks(documentId: string): DocumentChunk[] {
  const db = getDb()
  if (db) {
    const rows = db.prepare(
      'SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index',
    ).all(documentId) as any[]
    return rows.map(row => ({
      id: row.id,
      documentId: row.document_id ?? row.documentId,
      knowledgeBaseId: row.knowledge_base_id ?? row.knowledgeBaseId,
      chunkIndex: row.chunk_index ?? row.chunkIndex,
      content: row.content,
      startOffset: row.start_offset ?? row.startOffset ?? 0,
      charLength: row.char_length ?? row.charLength ?? 0,
      createdAt: row.created_at ?? row.createdAt ?? '',
    }))
  }
  const all = jsonGetAll('knowledge_chunks')
  return Object.values(all)
    .map((row: any) => ({
      id: row.id,
      documentId: row.document_id ?? row.documentId,
      knowledgeBaseId: row.knowledge_base_id ?? row.knowledgeBaseId,
      chunkIndex: row.chunk_index ?? row.chunkIndex,
      content: row.content,
      startOffset: row.start_offset ?? row.startOffset ?? 0,
      charLength: row.char_length ?? row.charLength ?? 0,
      createdAt: row.created_at ?? row.createdAt ?? '',
    }))
    .filter(c => c.documentId === documentId)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
}

export function deleteDocument(id: string): boolean {
  const doc = getDocument(id)
  if (!doc) return false

  const db = getDb()
  if (db) {
    db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id)
    db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)
  } else {
    // JSON fallback
    const allChunks = jsonGetAll('knowledge_chunks')
    for (const [chunkId, chunk] of Object.entries(allChunks)) {
      if ((chunk as any).document_id === id || (chunk as any).documentId === id) {
        jsonDelete('knowledge_chunks', chunkId)
      }
    }
    jsonDelete('knowledge_documents', id)
  }

  // Decrement knowledge base counters
  incrementKbCounters(doc.knowledgeBaseId, -1, -(doc.chunkCount), -(doc.sizeBytes))
  return true
}

function updateDocumentStatus(
  id: string,
  status: DocumentStatus,
  errorMessage?: string,
  chunkCount?: number,
): void {
  const db = getDb()
  const now = new Date().toISOString()
  if (db) {
    db.prepare(`
      UPDATE knowledge_documents
      SET status = ?, error_message = ?, chunk_count = ?, updated_at = ?
      WHERE id = ?
    `).run(status, errorMessage ?? null, chunkCount ?? 0, now, id)
  } else {
    const existing = jsonGet('knowledge_documents', id)
    if (existing) {
      const merged: Record<string, any> = { ...existing, status, chunkCount: chunkCount ?? 0, updatedAt: now }
      if (errorMessage) merged.errorMessage = errorMessage
      jsonSet('knowledge_documents', id, merged)
    }
  }
}

// ─── Chunk helpers ──────────────────────────────────────────────────

function insertChunk(db: import('node:sqlite').DatabaseSync | null, chunk: DocumentChunk): void {
  if (db) {
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, document_id, knowledge_base_id, chunk_index, content,
         start_offset, char_length, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunk.id, chunk.documentId, chunk.knowledgeBaseId,
      chunk.chunkIndex, chunk.content,
      chunk.startOffset, chunk.charLength, chunk.createdAt,
    )
  } else {
    jsonSet('knowledge_chunks', chunk.id, chunkRowToJson(chunk))
  }
}

// ─── Retrieval ──────────────────────────────────────────────────────

export function queryKnowledgeBases(request: RetrievalRequest): RetrievalResult[] {
  const db = getDb()
  if (!db) {
    // JSON fallback — basic keyword search
    return queryKeywordJson(request)
  }

  // Use FTS5 for keyword and hybrid modes when available
  if (ftsEnabled && (request.mode === 'keyword' || request.mode === 'hybrid')) {
    const results = queryFts(db, request)
    if (results.length > 0) return results
    // FTS5 returned nothing — fall through to LIKE
  }

  // LIKE-based search (fallback or when FTS5 is unavailable)
  return queryLike(db, request)
}

function queryFts(
  db: import('node:sqlite').DatabaseSync,
  request: RetrievalRequest,
): RetrievalResult[] {
  const { knowledgeBaseIds, query, topK, minScore } = request

  // Escape double quotes in the query text, then wrap in FTS5 phrase syntax
  const escapedQuery = query.replace(/"/g, '""')
  const ftsQuery = `"${escapedQuery}"`

  // Filter by knowledge base IDs
  const kbFilter = knowledgeBaseIds.length > 0
    ? `AND c.knowledge_base_id IN (${knowledgeBaseIds.map(() => '?').join(',')})`
    : ''

  const sql = `
    SELECT
      c.id as chunk_id,
      c.document_id,
      c.knowledge_base_id,
      c.chunk_index,
      c.content,
      c.start_offset,
      c.char_length,
      c.created_at,
      d.title as doc_title,
      d.mime_type as doc_mime,
      d.id as doc_id,
      rank
    FROM knowledge_chunks_fts f
    JOIN knowledge_chunks c ON f.rowid = c.rowid
    JOIN knowledge_documents d ON c.document_id = d.id
    WHERE f.knowledge_chunks_fts MATCH ?
    ${kbFilter}
    ORDER BY rank
    LIMIT ?
  `

  const params = knowledgeBaseIds.length > 0
    ? [ftsQuery, ...knowledgeBaseIds, topK]
    : [ftsQuery, topK]

  try {
    const rows = db.prepare(sql).all(...params) as any[]

    // Convert BM25 rank to a normalized score (0-1)
    const results: RetrievalResult[] = []
    for (const row of rows) {
      const bm25 = -row.rank
      const score = bm25 / (1 + bm25)
      if (score < minScore) continue

      results.push({
        chunk: {
          id: row.chunk_id,
          documentId: row.document_id,
          knowledgeBaseId: row.knowledge_base_id,
          chunkIndex: row.chunk_index,
          content: row.content,
          startOffset: row.start_offset,
          charLength: row.char_length,
          createdAt: row.created_at,
        },
        score,
        document: {
          id: row.doc_id,
          title: row.doc_title,
          mimeType: row.doc_mime,
        },
      })
    }

    return results
  } catch {
    // FTS5 query syntax error — fall back to LIKE search
    return []
  }
}

function queryLike(
  db: import('node:sqlite').DatabaseSync,
  request: RetrievalRequest,
): RetrievalResult[] {
  const { knowledgeBaseIds, query, topK } = request
  const likePattern = `%${query}%`

  const kbFilter = knowledgeBaseIds.length > 0
    ? `AND c.knowledge_base_id IN (${knowledgeBaseIds.map(() => '?').join(',')})`
    : ''

  const sql = `
    SELECT c.*, d.title as doc_title, d.mime_type as doc_mime, d.id as doc_id
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON c.document_id = d.id
    WHERE c.content LIKE ?
    ${kbFilter}
    LIMIT ?
  `

  const params = knowledgeBaseIds.length > 0
    ? [likePattern, ...knowledgeBaseIds, topK]
    : [likePattern, topK]

  const rows = db.prepare(sql).all(...params) as any[]
  return rows.map(row => ({
    chunk: {
      id: row.id,
      documentId: row.document_id,
      knowledgeBaseId: row.knowledge_base_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      startOffset: row.start_offset,
      charLength: row.char_length,
      createdAt: row.created_at,
    },
    score: 0.5,
    document: {
      id: row.doc_id,
      title: row.doc_title,
      mimeType: row.doc_mime,
    },
  }))
}

function queryKeywordJson(request: RetrievalRequest): RetrievalResult[] {
  const allChunks = jsonGetAll('knowledge_chunks')
  const allDocs = jsonGetAll('knowledge_documents')
  const results: RetrievalResult[] = []
  const lowerQuery = request.query.toLowerCase()

  for (const chunk of Object.values(allChunks) as any[]) {
    if (request.knowledgeBaseIds.length > 0 &&
        !request.knowledgeBaseIds.includes(chunk.knowledge_base_id ?? chunk.knowledgeBaseId)) {
      continue
    }
    if (!(chunk.content ?? '').toLowerCase().includes(lowerQuery)) continue

    const doc = allDocs[chunk.document_id ?? chunk.documentId] as any
    results.push({
      chunk: {
        id: chunk.id,
        documentId: chunk.document_id ?? chunk.documentId,
        knowledgeBaseId: chunk.knowledge_base_id ?? chunk.knowledgeBaseId,
        chunkIndex: chunk.chunk_index ?? chunk.chunkIndex ?? 0,
        content: chunk.content,
        startOffset: chunk.start_offset ?? chunk.startOffset ?? 0,
        charLength: chunk.char_length ?? chunk.charLength ?? chunk.content?.length ?? 0,
        createdAt: chunk.created_at ?? chunk.createdAt ?? '',
      },
      score: 0.5,
      document: {
        id: doc?.id ?? '',
        title: doc?.title ?? '',
        mimeType: doc?.mime_type ?? doc?.mimeType ?? 'text/plain',
      },
    })
  }

  return results.slice(0, request.topK)
}

// ─── Knowledge base counter updates ────────────────────────────────

function incrementKbCounters(
  kbId: string,
  docDelta: number,
  chunkDelta: number,
  sizeDelta: number,
): void {
  const db = getDb()
  if (db) {
    db.prepare(`
      UPDATE knowledge_bases
      SET document_count = document_count + ?,
          chunk_count = chunk_count + ?,
          total_size_bytes = total_size_bytes + ?,
          updated_at = ?
      WHERE id = ?
    `).run(docDelta, chunkDelta, sizeDelta, new Date().toISOString(), kbId)
  } else {
    const existing = jsonGet('knowledge_bases', kbId)
    if (existing) {
      existing.document_count = (existing.document_count ?? 0) + docDelta
      existing.chunk_count = (existing.chunk_count ?? 0) + chunkDelta
      existing.total_size_bytes = (existing.total_size_bytes ?? 0) + sizeDelta
      existing.updated_at = new Date().toISOString()
      jsonSet('knowledge_bases', kbId, existing)
    }
  }
}

// ─── Text chunking ──────────────────────────────────────────────────

interface ChunkOutput {
  index: number
  text: string
  startOffset: number
}

export function chunkText(text: string, strategy: ChunkStrategy): ChunkOutput[] {
  if (!text || text.trim().length === 0) return []

  switch (strategy.type) {
    case 'fixed':
      return chunkFixed(text, strategy.chunkSize, strategy.overlap, strategy.minChunkSize)
    case 'sentence':
      return chunkSentence(text, strategy.chunkSize, strategy.overlap, strategy.minChunkSize)
    case 'paragraph':
      return chunkParagraph(text, strategy.chunkSize, strategy.overlap, strategy.minChunkSize)
    default:
      return chunkFixed(text, strategy.chunkSize, strategy.overlap, strategy.minChunkSize)
  }
}

function chunkFixed(
  text: string,
  chunkSize: number,
  overlap: number,
  minChunkSize: number,
): ChunkOutput[] {
  const chunks: ChunkOutput[] = []
  const len = text.length
  let offset = 0
  let index = 0

  while (offset < len) {
    const end = Math.min(offset + chunkSize, len)
    const chunkText = text.slice(offset, end).trim()
    if (chunkText.length >= minChunkSize || offset + chunkSize >= len) {
      chunks.push({ index, text: chunkText, startOffset: offset })
      index++
    }
    offset += chunkSize - overlap
    if (offset >= len) break
  }

  // Merge last tiny chunk with previous if too small
  if (chunks.length >= 2 && chunks[chunks.length - 1].text.length < minChunkSize) {
    const last = chunks.pop()!
    chunks[chunks.length - 1].text += '\n' + last.text
  }

  return chunks
}

function chunkSentence(
  text: string,
  chunkSize: number,
  overlap: number,
  minChunkSize: number,
): ChunkOutput[] {
  const sentences = text.split(/(?<=[.!?。！？\n])\s*/)
  return mergeSegments(sentences, chunkSize, overlap, minChunkSize)
}

function chunkParagraph(
  text: string,
  chunkSize: number,
  overlap: number,
  minChunkSize: number,
): ChunkOutput[] {
  const paragraphs = text.split(/\n{2,}/)
  return mergeSegments(paragraphs, chunkSize, overlap, minChunkSize)
}

function mergeSegments(
  segments: string[],
  chunkSize: number,
  overlap: number,
  minChunkSize: number,
): ChunkOutput[] {
  const chunks: ChunkOutput[] = []
  let currentText = ''
  let currentOffset = 0
  let index = 0

  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) continue

    if (currentText.length + trimmed.length > chunkSize && currentText.length >= minChunkSize) {
      chunks.push({ index, text: currentText.trim(), startOffset: currentOffset })
      index++
      const overlapText = currentText.slice(Math.max(0, currentText.length - overlap))
      currentOffset += currentText.length - overlapText.length
      currentText = overlapText + '\n' + trimmed
    } else {
      currentText += '\n' + trimmed
    }
  }

  if (currentText.trim().length > 0) {
    chunks.push({ index, text: currentText.trim(), startOffset: currentOffset })
  }

  if (chunks.length >= 2 && chunks[chunks.length - 1].text.length < minChunkSize) {
    const last = chunks.pop()!
    chunks[chunks.length - 1].text += '\n' + last.text
  }

  return chunks
}

// ─── Row ↔ JSON converters ─────────────────────────────────────────

function kbRowToJson(kb: KnowledgeBase): Record<string, any> {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    profile_id: kb.profileId,
    chunk_strategy: JSON.stringify(kb.chunkStrategy),
    embedding_model: kb.embeddingModel,
    document_count: kb.documentCount,
    chunk_count: kb.chunkCount,
    total_size_bytes: kb.totalSizeBytes,
    created_at: kb.createdAt,
    updated_at: kb.updatedAt,
  }
}

function jsonToKb(row: any): KnowledgeBase {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    profileId: row.profile_id ?? row.profileId ?? '',
    chunkStrategy: typeof row.chunk_strategy === 'string'
      ? JSON.parse(row.chunk_strategy)
      : (row.chunkStrategy ?? DEFAULT_CHUNK_STRATEGY),
    embeddingModel: row.embedding_model ?? row.embeddingModel,
    documentCount: row.document_count ?? row.documentCount ?? 0,
    chunkCount: row.chunk_count ?? row.chunkCount ?? 0,
    totalSizeBytes: row.total_size_bytes ?? row.totalSizeBytes ?? 0,
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? '',
  }
}

function docRowToJson(doc: KnowledgeDocument): Record<string, any> {
  return {
    id: doc.id,
    knowledge_base_id: doc.knowledgeBaseId,
    title: doc.title,
    mime_type: doc.mimeType,
    status: doc.status,
    error_message: doc.errorMessage,
    content_hash: doc.contentHash,
    source_url: doc.sourceUrl,
    size_bytes: doc.sizeBytes,
    chunk_count: doc.chunkCount,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  }
}

function jsonToDoc(row: any): KnowledgeDocument {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id ?? row.knowledgeBaseId ?? '',
    title: row.title,
    mimeType: row.mime_type ?? row.mimeType ?? 'text/plain',
    status: row.status ?? 'pending',
    errorMessage: row.error_message ?? row.errorMessage,
    contentHash: row.content_hash ?? row.contentHash ?? '',
    sourceUrl: row.source_url ?? row.sourceUrl,
    sizeBytes: row.size_bytes ?? row.sizeBytes ?? 0,
    chunkCount: row.chunk_count ?? row.chunkCount ?? 0,
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? '',
  }
}

function chunkRowToJson(chunk: DocumentChunk): Record<string, any> {
  return {
    id: chunk.id,
    document_id: chunk.documentId,
    knowledge_base_id: chunk.knowledgeBaseId,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    start_offset: chunk.startOffset,
    char_length: chunk.charLength,
    created_at: chunk.createdAt,
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}
