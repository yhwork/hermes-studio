/**
 * Knowledge base types for Hermes Studio.
 *
 * A knowledge base is a named collection of documents that can be queried
 * by the agent at runtime. Documents are split into chunks, indexed for
 * keyword retrieval, and (in future phases) vectorized for semantic search.
 */

// ─── Knowledge Base ─────────────────────────────────────────────────

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  /** Profile that owns this knowledge base (empty = global). */
  profileId: string
  /** Chunking strategy configuration. */
  chunkStrategy: ChunkStrategy
  /** Embedding model identifier (reserved for Phase 2). */
  embeddingModel?: string
  /** Total number of documents in this knowledge base. */
  documentCount: number
  /** Total number of chunks across all documents. */
  chunkCount: number
  /** Total size in bytes of all source documents. */
  totalSizeBytes: number
  createdAt: string
  updatedAt: string
}

// ─── Documents ──────────────────────────────────────────────────────

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'error' | 'deleted'

export interface KnowledgeDocument {
  id: string
  knowledgeBaseId: string
  /** Original file name or title. */
  title: string
  /** MIME type or source format. */
  mimeType: string
  /** Current processing status. */
  status: DocumentStatus
  /** Error message if status is 'error'. */
  errorMessage?: string
  /** Raw source content (text or base64-encoded binary). */
  content?: string
  /** Source URL if the document was fetched from a URL. */
  sourceUrl?: string
  /** File size in bytes. */
  sizeBytes: number
  /** Number of chunks produced from this document. */
  chunkCount: number
  /** SHA-256 hash of the source content for deduplication. */
  contentHash: string
  createdAt: string
  updatedAt: string
}

// ─── Chunks ─────────────────────────────────────────────────────────

export interface DocumentChunk {
  id: string
  documentId: string
  knowledgeBaseId: string
  /** Zero-based index of this chunk within the document. */
  chunkIndex: number
  /** The text content of this chunk. */
  content: string
  /** Character offset of this chunk within the original document. */
  startOffset: number
  /** Character length of this chunk (may differ from content.length after normalization). */
  charLength: number
  /** Embedding vector (reserved for Phase 2 — sqlite-vec). */
  embedding?: number[]
  createdAt: string
}

// ─── Chunking Strategy ──────────────────────────────────────────────

export type ChunkStrategyType = 'fixed' | 'sentence' | 'paragraph'

export interface ChunkStrategy {
  /** Chunking algorithm. */
  type: ChunkStrategyType
  /** Target chunk size in characters. */
  chunkSize: number
  /** Overlap between consecutive chunks in characters. */
  overlap: number
  /** Minimum chunk size — smaller chunks are merged with neighbors. */
  minChunkSize: number
}

export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = {
  type: 'fixed',
  chunkSize: 512,
  overlap: 64,
  minChunkSize: 100,
}

// ─── Retrieval ──────────────────────────────────────────────────────

export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid'

export interface RetrievalRequest {
  /** The knowledge base IDs to search within. */
  knowledgeBaseIds: string[]
  /** The search query text. */
  query: string
  /** Retrieval algorithm. */
  mode: RetrievalMode
  /** Maximum number of results to return. */
  topK: number
  /** Minimum relevance score (0-1) for a result to be included. */
  minScore: number
}

export interface RetrievalResult {
  /** The matching chunk. */
  chunk: DocumentChunk
  /** Relevance score (0-1). */
  score: number
  /** The parent document metadata. */
  document: Pick<KnowledgeDocument, 'id' | 'title' | 'mimeType'>
}

// ─── API Request/Response ───────────────────────────────────────────

export interface CreateKnowledgeBaseRequest {
  name: string
  description?: string
  chunkStrategy?: Partial<ChunkStrategy>
}

export interface UpdateKnowledgeBaseRequest {
  name?: string
  description?: string
  chunkStrategy?: Partial<ChunkStrategy>
}

export interface AddDocumentRequest {
  title: string
  content: string
  mimeType?: string
  sourceUrl?: string
}

export interface QueryKnowledgeBaseInput extends Record<string, unknown> {
  query: string
  knowledge_base_ids?: string[]
  mode?: RetrievalMode
  top_k?: number
}
