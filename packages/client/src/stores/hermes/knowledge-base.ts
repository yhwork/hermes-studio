import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '@/api/hermes/knowledge-base'
import type { KnowledgeBase, KnowledgeDocument, ChunkStrategy } from '@/api/hermes/knowledge-base'
import { hasApiKey } from '@/api/client'

export const useKnowledgeBaseStore = defineStore('knowledge-base', () => {
  // ─── State ────────────────────────────────────────────────────────

  const knowledgeBases = ref<KnowledgeBase[]>([])
  const documents = ref<Map<string, KnowledgeDocument[]>>(new Map())
  const loading = ref(false)
  const loadingDocs = ref<Map<string, boolean>>(new Map())

  // ─── Getters ──────────────────────────────────────────────────────

  const totalDocuments = computed(() =>
    knowledgeBases.value.reduce((sum, kb) => sum + kb.documentCount, 0),
  )

  const totalChunks = computed(() =>
    knowledgeBases.value.reduce((sum, kb) => sum + kb.chunkCount, 0),
  )

  function getDocumentsForKb(kbId: string): KnowledgeDocument[] {
    return documents.value.get(kbId) ?? []
  }

  function isLoadingDocs(kbId: string): boolean {
    return loadingDocs.value.get(kbId) ?? false
  }

  // ─── Actions ──────────────────────────────────────────────────────

  async function fetchKnowledgeBases() {
    if (!hasApiKey()) return
    loading.value = true
    try {
      knowledgeBases.value = await api.fetchKnowledgeBases()
    } catch (err) {
      console.error('Failed to fetch knowledge bases:', err)
    } finally {
      loading.value = false
    }
  }

  async function createKnowledgeBase(params: {
    name: string
    description?: string
    chunkStrategy?: Partial<ChunkStrategy>
  }): Promise<KnowledgeBase | undefined> {
    try {
      const kb = await api.createKnowledgeBase(params)
      knowledgeBases.value.unshift(kb)
      return kb
    } catch (err) {
      console.error('Failed to create knowledge base:', err)
      return undefined
    }
  }

  async function updateKnowledgeBase(
    id: string,
    params: {
      name?: string
      description?: string
      chunkStrategy?: Partial<ChunkStrategy>
    },
  ): Promise<KnowledgeBase | undefined> {
    try {
      const updated = await api.updateKnowledgeBase(id, params)
      const idx = knowledgeBases.value.findIndex(kb => kb.id === id)
      if (idx >= 0) knowledgeBases.value[idx] = updated
      return updated
    } catch (err) {
      console.error('Failed to update knowledge base:', err)
      return undefined
    }
  }

  async function deleteKnowledgeBase(id: string): Promise<boolean> {
    try {
      await api.deleteKnowledgeBase(id)
      knowledgeBases.value = knowledgeBases.value.filter(kb => kb.id !== id)
      documents.value.delete(id)
      return true
    } catch (err) {
      console.error('Failed to delete knowledge base:', err)
      return false
    }
  }

  async function fetchDocuments(kbId: string) {
    loadingDocs.value.set(kbId, true)
    try {
      const docs = await api.fetchDocuments(kbId)
      documents.value.set(kbId, docs)
    } catch (err) {
      console.error('Failed to fetch documents:', err)
    } finally {
      loadingDocs.value.set(kbId, false)
    }
  }

  async function addDocument(
    kbId: string,
    params: {
      title: string
      content: string
      mimeType?: string
      sourceUrl?: string
    },
  ): Promise<KnowledgeDocument | undefined> {
    try {
      const doc = await api.addDocument(kbId, params)
      // Refresh the document list for this knowledge base
      const existing = documents.value.get(kbId) ?? []
      documents.value.set(kbId, [doc, ...existing])
      // Update the knowledge base counters
      const kb = knowledgeBases.value.find(k => k.id === kbId)
      if (kb) {
        kb.documentCount++
        kb.chunkCount += doc.chunkCount
        kb.totalSizeBytes += doc.sizeBytes
      }
      return doc
    } catch (err) {
      console.error('Failed to add document:', err)
      return undefined
    }
  }

  async function uploadDocument(
    kbId: string,
    file: File,
    options?: { title?: string },
  ): Promise<KnowledgeDocument | undefined> {
    try {
      const doc = await api.uploadDocument(kbId, file, options)
      // Refresh the document list for this knowledge base
      const existing = documents.value.get(kbId) ?? []
      documents.value.set(kbId, [doc, ...existing])
      // Update the knowledge base counters
      const kb = knowledgeBases.value.find(k => k.id === kbId)
      if (kb) {
        kb.documentCount++
        kb.chunkCount += doc.chunkCount
        kb.totalSizeBytes += doc.sizeBytes
      }
      return doc
    } catch (err) {
      console.error('Failed to upload document:', err)
      return undefined
    }
  }

  async function deleteDocument(kbId: string, docId: string): Promise<boolean> {
    try {
      await api.deleteDocument(kbId, docId)
      const existing = documents.value.get(kbId) ?? []
      const doc = existing.find(d => d.id === docId)
      documents.value.set(kbId, existing.filter(d => d.id !== docId))
      // Update the knowledge base counters
      const kb = knowledgeBases.value.find(k => k.id === kbId)
      if (kb && doc) {
        kb.documentCount = Math.max(0, kb.documentCount - 1)
        kb.chunkCount = Math.max(0, kb.chunkCount - doc.chunkCount)
        kb.totalSizeBytes = Math.max(0, kb.totalSizeBytes - doc.sizeBytes)
      }
      return true
    } catch (err) {
      console.error('Failed to delete document:', err)
      return false
    }
  }

  async function getDocumentContent(kbId: string, docId: string): Promise<{ document: any; chunks: any[]; fullContent: string } | undefined> {
    try {
      return await api.getDocumentContent(kbId, docId)
    } catch (err) {
      console.error('Failed to get document content:', err)
      return undefined
    }
  }

  return {
    // State
    knowledgeBases,
    documents,
    loading,
    loadingDocs,
    // Getters
    totalDocuments,
    totalChunks,
    getDocumentsForKb,
    isLoadingDocs,
    // Actions
    fetchKnowledgeBases,
    createKnowledgeBase,
    updateKnowledgeBase,
    deleteKnowledgeBase,
    fetchDocuments,
    addDocument,
    uploadDocument,
    getDocumentContent,
    deleteDocument,
  }
})
