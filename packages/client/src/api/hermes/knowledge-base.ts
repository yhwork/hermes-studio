import { request } from '../client'

// ─── Types ──────────────────────────────────────────────────────────

export interface ChunkStrategy {
  type: 'fixed' | 'sentence' | 'paragraph'
  chunkSize: number
  overlap: number
  minChunkSize: number
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

export interface RetrievalResult {
  chunk: {
    id: string
    documentId: string
    knowledgeBaseId: string
    chunkIndex: number
    content: string
    startOffset: number
    charLength: number
    createdAt: string
  }
  score: number
  document: {
    id: string
    title: string
    mimeType: string
  }
}

// ─── API ────────────────────────────────────────────────────────────

export async function fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
  return request<KnowledgeBase[]>('/api/hermes/knowledge-bases')
}

export async function fetchKnowledgeBase(id: string): Promise<KnowledgeBase> {
  return request<KnowledgeBase>(`/api/hermes/knowledge-bases/${encodeURIComponent(id)}`)
}

export async function createKnowledgeBase(params: {
  name: string
  description?: string
  chunkStrategy?: Partial<ChunkStrategy>
}): Promise<KnowledgeBase> {
  return request<KnowledgeBase>('/api/hermes/knowledge-bases', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function updateKnowledgeBase(
  id: string,
  params: {
    name?: string
    description?: string
    chunkStrategy?: Partial<ChunkStrategy>
  },
): Promise<KnowledgeBase> {
  return request<KnowledgeBase>(`/api/hermes/knowledge-bases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  })
}

export async function deleteKnowledgeBase(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/hermes/knowledge-bases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function fetchDocuments(kbId: string): Promise<KnowledgeDocument[]> {
  return request<KnowledgeDocument[]>(`/api/hermes/knowledge-bases/${encodeURIComponent(kbId)}/documents`)
}

export async function addDocument(
  kbId: string,
  params: {
    title: string
    content: string
    mimeType?: string
    sourceUrl?: string
  },
): Promise<KnowledgeDocument> {
  return request<KnowledgeDocument>(`/api/hermes/knowledge-bases/${encodeURIComponent(kbId)}/documents`, {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function uploadDocument(
  kbId: string,
  file: File,
  options?: {
    title?: string
  },
): Promise<KnowledgeDocument> {
  const formData = new FormData()
  formData.append('file', file)
  if (options?.title) {
    formData.append('title', options.title)
  }
  
  // Use fetch for multipart upload
  const res = await fetch(`/api/hermes/knowledge-bases/${encodeURIComponent(kbId)}/documents/upload`, {
    method: 'POST',
    body: formData,
  })
  
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(error.error || 'Upload failed')
  }
  
  return res.json()
}

export async function getDocumentContent(kbId: string, docId: string): Promise<{ document: any; chunks: any[]; fullContent: string }> {
  return request(`/api/hermes/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/content`)
}

export async function deleteDocument(kbId: string, docId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/api/hermes/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE' },
  )
}

export async function queryKnowledgeBases(params: {
  knowledgeBaseIds?: string[]
  query: string
  mode?: 'keyword' | 'semantic' | 'hybrid'
  topK?: number
}): Promise<{ results: RetrievalResult[] }> {
  return request('/api/hermes/knowledge-bases/query', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}
