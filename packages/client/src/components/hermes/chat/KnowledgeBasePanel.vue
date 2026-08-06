<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NInputNumber, NModal, NSelect, NEmpty, NSpin, NPopconfirm, useMessage } from 'naive-ui'
import { useKnowledgeBaseStore } from '@/stores/hermes/knowledge-base'
import type { KnowledgeBase, KnowledgeDocument } from '@/api/hermes/knowledge-base'

const { t } = useI18n()
const message = useMessage()
const kbStore = useKnowledgeBaseStore()

// ─── State ──────────────────────────────────────────────────────────

const showCreateDialog = ref(false)
const newKbName = ref('')
const newKbDescription = ref('')
const newKbChunkSize = ref(512)
const newKbOverlap = ref(64)
const creating = ref(false)

const expandedKbId = ref<string | null>(null)

const showAddDocDialog = ref(false)
const addDocKbId = ref('')
const addDocTitle = ref('')
const addDocContent = ref('')
const addingDoc = ref(false)

const showPreviewDialog = ref(false)
const previewDocContent = ref('')
const previewDocTitle = ref('')
const previewLoading = ref(false)

const kbSearchQuery = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploadTargetKbId = ref('')

// ─── Computed ───────────────────────────────────────────────────────

const knowledgeBases = computed(() => kbStore.knowledgeBases)
const loading = computed(() => kbStore.loading)

const chunkStrategyOptions = [
  { label: 'Fixed', value: 'fixed' },
  { label: 'Sentence', value: 'sentence' },
  { label: 'Paragraph', value: 'paragraph' },
]
const newKbStrategy = ref('fixed')

// ─── Lifecycle ──────────────────────────────────────────────────────

onMounted(() => {
  kbStore.fetchKnowledgeBases()
})

// ─── KB CRUD ────────────────────────────────────────────────────────

function openCreateDialog() {
  newKbName.value = ''
  newKbDescription.value = ''
  newKbChunkSize.value = 512
  newKbOverlap.value = 64
  newKbStrategy.value = 'fixed'
  showCreateDialog.value = true
}

async function handleCreateKb() {
  if (!newKbName.value.trim()) {
    message.warning(t('knowledgeBase.nameRequired'))
    return
  }
  creating.value = true
  try {
    const kb = await kbStore.createKnowledgeBase({
      name: newKbName.value.trim(),
      description: newKbDescription.value.trim() || undefined,
      chunkStrategy: {
        type: newKbStrategy.value as any,
        chunkSize: newKbChunkSize.value,
        overlap: newKbOverlap.value,
      },
    })
    if (kb) {
      message.success(t('knowledgeBase.created'))
      showCreateDialog.value = false
    }
  } finally {
    creating.value = false
  }
}

async function handleDeleteKb(id: string) {
  const ok = await kbStore.deleteKnowledgeBase(id)
  if (ok) {
    message.success(t('knowledgeBase.deleted'))
    if (expandedKbId.value === id) expandedKbId.value = null
  }
}

function toggleExpand(kb: KnowledgeBase) {
  if (expandedKbId.value === kb.id) {
    expandedKbId.value = null
  } else {
    expandedKbId.value = kb.id
    kbStore.fetchDocuments(kb.id)
  }
}

// ─── Document CRUD ──────────────────────────────────────────────────

function openAddDocDialog(kbId: string) {
  addDocKbId.value = kbId
  addDocTitle.value = ''
  addDocContent.value = ''
  showAddDocDialog.value = true
}

async function handleAddDoc() {
  if (!addDocTitle.value.trim()) {
    message.warning(t('knowledgeBase.docTitleRequired'))
    return
  }
  if (!addDocContent.value.trim()) {
    message.warning(t('knowledgeBase.docContentRequired'))
    return
  }
  addingDoc.value = true
  try {
    const doc = await kbStore.addDocument(addDocKbId.value, {
      title: addDocTitle.value.trim(),
      content: addDocContent.value.trim(),
    })
    if (doc) {
      message.success(t('knowledgeBase.docAdded'))
      showAddDocDialog.value = false
    }
  } finally {
    addingDoc.value = false
  }
}

async function handleDeleteDoc(kbId: string, docId: string) {
  const ok = await kbStore.deleteDocument(kbId, docId)
  if (ok) message.success(t('knowledgeBase.docDeleted'))
}

// ─── File Upload ────────────────────────────────────────────────────

function triggerFileUpload(kbId: string) {
  uploadTargetKbId.value = kbId
  if (fileInputRef.value) {
    fileInputRef.value.click()
  }
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file && uploadTargetKbId.value) {
    handleFileUpload(uploadTargetKbId.value, file)
    if (fileInputRef.value) {
      fileInputRef.value.value = '' // Reset input
    }
  }
}

async function handleFileUpload(kbId: string, file: File) {
  const title = file.name.replace(/\.[^/.]+$/, '')
  
  try {
    const doc = await kbStore.uploadDocument(kbId, file, { title })
    if (doc) {
      message.success(t('knowledgeBase.docAdded'))
      return doc
    } else {
      message.error(t('knowledgeBase.uploadFailed'))
    }
  } catch (err) {
    console.error('Upload failed:', err)
    message.error(t('knowledgeBase.uploadFailed'))
  }
}

function getFileTypeIcon(mimeType: string): string {
  if (mimeType.includes('pdf')) return '📄'
  if (mimeType.includes('word') || mimeType.includes('document')) return '📝'
  if (mimeType.includes('text') || mimeType.includes('markdown')) return '📃'
  return '📎'
}

// ─── Document Preview ───────────────────────────────────────────────

async function handlePreviewDoc(kbId: string, docId: string, title: string) {
  previewDocTitle.value = title
  previewDocContent.value = ''
  previewLoading.value = true
  showPreviewDialog.value = true
  
  try {
    const result = await kbStore.getDocumentContent(kbId, docId)
    previewDocContent.value = result?.fullContent || ''
  } catch (err) {
    console.error('Failed to load document content:', err)
    message.error(t('knowledgeBase.loadFailed'))
    showPreviewDialog.value = false
  } finally {
    previewLoading.value = false
  }
}

// ─── Search Filter ──────────────────────────────────────────────────

const filteredKnowledgeBases = computed(() => {
  if (!kbSearchQuery.value.trim()) {
    return knowledgeBases.value
  }
  const query = kbSearchQuery.value.toLowerCase()
  return knowledgeBases.value.filter(kb => 
    kb.name.toLowerCase().includes(query) ||
    kb.description?.toLowerCase().includes(query)
  )
})

// ─── Formatting helpers ─────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function docStatusColor(status: KnowledgeDocument['status']): string {
  switch (status) {
    case 'ready': return 'var(--success, #18a058)'
    case 'pending':
    case 'processing': return 'var(--warning, #f0a020)'
    case 'error': return 'var(--error, #d03050)'
    case 'deleted': return 'var(--text-muted, #999)'
    default: return 'var(--text-muted, #999)'
  }
}
</script>

<template>
  <div class="kb-panel">
    <!-- Header -->
    <div class="kb-panel-header">
      <span class="kb-panel-title">{{ t('knowledgeBase.title') }}</span>
      <NButton size="small" type="primary" @click="openCreateDialog">
        {{ t('knowledgeBase.create') }}
      </NButton>
    </div>

    <!-- Search Filter -->
    <div class="kb-search-bar" v-if="knowledgeBases.length > 0">
      <NInput
        v-model:value="kbSearchQuery"
        :placeholder="t('knowledgeBase.searchPlaceholder')"
        size="small"
        clearable
      >
        <template #prefix>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
        </template>
      </NInput>
    </div>

    <!-- Hidden file input (outside v-for) -->
    <input
      type="file"
      ref="fileInputRef"
      style="display: none"
      accept=".txt,.md,.pdf,.doc,.docx,.csv,.json"
      @change="handleFileSelect"
    />

    <!-- Loading -->
    <div v-if="loading" class="kb-loading">
      <NSpin size="small" />
    </div>

    <!-- Empty state -->
    <div v-else-if="filteredKnowledgeBases.length === 0" class="kb-empty">
      <NEmpty :description="kbSearchQuery ? t('knowledgeBase.noResults') : t('knowledgeBase.empty')" />
    </div>

    <!-- Knowledge base list -->
    <div v-else class="kb-list">
      <div
        v-for="kb in filteredKnowledgeBases"
        :key="kb.id"
        class="kb-item"
        :class="{ 'kb-item--expanded': expandedKbId === kb.id }"
      >
        <button class="kb-item-header" type="button" @click="toggleExpand(kb)">
          <div class="kb-item-info">
            <span class="kb-item-name">{{ kb.name }}</span>
            <span v-if="kb.description" class="kb-item-desc">{{ kb.description }}</span>
          </div>
          <div class="kb-item-stats">
            <span class="kb-stat">{{ t('knowledgeBase.docCount', { count: kb.documentCount }) }}</span>
            <span class="kb-stat">{{ t('knowledgeBase.chunkCount', { count: kb.chunkCount }) }}</span>
            <span class="kb-stat">{{ formatSize(kb.totalSizeBytes) }}</span>
          </div>
          <svg
            class="kb-item-chevron"
            :class="{ 'kb-item-chevron--open': expandedKbId === kb.id }"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <!-- Expanded: documents list -->
        <div v-if="expandedKbId === kb.id" class="kb-item-body">
          <div class="kb-doc-actions">
            <NButton size="tiny" @click="openAddDocDialog(kb.id)">
              {{ t('knowledgeBase.addDoc') }}
            </NButton>
            <NButton size="tiny" type="info" @click="triggerFileUpload(kb.id)">
              {{ t('knowledgeBase.uploadFile') }}
            </NButton>
          </div>

          <div v-if="kbStore.isLoadingDocs(kb.id)" class="kb-doc-loading">
            <NSpin size="small" />
          </div>

          <div v-else-if="kbStore.getDocumentsForKb(kb.id).length === 0" class="kb-doc-empty">
            {{ t('knowledgeBase.noDocs') }}
          </div>

          <div v-else class="kb-doc-list">
            <div
              v-for="doc in kbStore.getDocumentsForKb(kb.id)"
              :key="doc.id"
              class="kb-doc-item"
            >
              <div class="kb-doc-info">
                <span class="kb-doc-type-icon">{{ getFileTypeIcon(doc.mimeType) }}</span>
                <span class="kb-doc-title">{{ doc.title }}</span>
                <span class="kb-doc-status" :style="{ color: docStatusColor(doc.status) }">
                  {{ doc.status }}
                </span>
              </div>
              <div class="kb-doc-meta">
                <span>{{ formatSize(doc.sizeBytes) }}</span>
                <span>{{ t('knowledgeBase.chunkCount', { count: doc.chunkCount }) }}</span>
                <span>{{ formatTime(doc.createdAt) }}</span>
              </div>
              <div v-if="doc.errorMessage" class="kb-doc-error">{{ doc.errorMessage }}</div>
              <div class="kb-doc-actions-row">
                <button 
                  class="kb-doc-action-btn" 
                  type="button" 
                  :title="t('knowledgeBase.preview')"
                  @click.stop="handlePreviewDoc(kb.id, doc.id, doc.title)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
                <NPopconfirm @positive-click="handleDeleteDoc(kb.id, doc.id)">
                  <template #trigger>
                    <button class="kb-doc-delete" type="button" :title="t('knowledgeBase.deleteDoc')">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </template>
                  {{ t('knowledgeBase.confirmDeleteDoc') }}
                </NPopconfirm>
              </div>
            </div>
          </div>
        </div>

        <!-- Delete KB action -->
        <div v-if="expandedKbId === kb.id" class="kb-item-footer">
          <NPopconfirm @positive-click="handleDeleteKb(kb.id)">
            <template #trigger>
              <NButton size="tiny" type="error" ghost>{{ t('knowledgeBase.deleteKb') }}</NButton>
            </template>
            {{ t('knowledgeBase.confirmDeleteKb') }}
          </NPopconfirm>
        </div>
      </div>
    </div>

    <!-- Create KB dialog -->
    <NModal
      v-model:show="showCreateDialog"
      preset="dialog"
      :title="t('knowledgeBase.createTitle')"
      :positive-text="t('knowledgeBase.create')"
      :negative-text="t('knowledgeBase.cancel')"
      :loading="creating"
      @positive-click="handleCreateKb"
    >
      <div class="kb-form">
        <div class="kb-form-field">
          <label>{{ t('knowledgeBase.nameLabel') }}</label>
          <NInput v-model:value="newKbName" :placeholder="t('knowledgeBase.namePlaceholder')" />
        </div>
        <div class="kb-form-field">
          <label>{{ t('knowledgeBase.descriptionLabel') }}</label>
          <NInput v-model:value="newKbDescription" type="textarea" :rows="2" :placeholder="t('knowledgeBase.descriptionPlaceholder')" />
        </div>
        <div class="kb-form-row">
          <div class="kb-form-field">
            <label>{{ t('knowledgeBase.chunkStrategyLabel') }}</label>
            <NSelect v-model:value="newKbStrategy" :options="chunkStrategyOptions" />
          </div>
          <div class="kb-form-field">
            <label>{{ t('knowledgeBase.chunkSizeLabel') }}</label>
            <NInputNumber v-model:value="newKbChunkSize" :min="100" :max="4096" />
          </div>
          <div class="kb-form-field">
            <label>{{ t('knowledgeBase.overlapLabel') }}</label>
            <NInputNumber v-model:value="newKbOverlap" :min="0" :max="1024" />
          </div>
        </div>
      </div>
    </NModal>

    <!-- Add document dialog -->
    <NModal
      v-model:show="showAddDocDialog"
      preset="dialog"
      :title="t('knowledgeBase.addDocTitle')"
      :positive-text="t('knowledgeBase.addDoc')"
      :negative-text="t('knowledgeBase.cancel')"
      :loading="addingDoc"
      @positive-click="handleAddDoc"
    >
      <div class="kb-form">
        <div class="kb-form-field">
          <label>{{ t('knowledgeBase.docTitleLabel') }}</label>
          <NInput v-model:value="addDocTitle" :placeholder="t('knowledgeBase.docTitlePlaceholder')" />
        </div>
        <div class="kb-form-field">
          <label>{{ t('knowledgeBase.docContentLabel') }}</label>
          <NInput v-model:value="addDocContent" type="textarea" :rows="8" :placeholder="t('knowledgeBase.docContentPlaceholder')" />
        </div>
      </div>
    </NModal>

    <!-- Preview document dialog -->
    <NModal
      v-model:show="showPreviewDialog"
      preset="card"
      :title="previewDocTitle"
      :style="{ width: '700px', maxWidth: '90vw' }"
      :segmented="{ content: true, footer: 'soft' }"
    >
      <div class="kb-preview-content">
        <NSpin v-if="previewLoading" size="medium" />
        <NInput
          v-else
          type="textarea"
          :value="previewDocContent"
          :rows="20"
          readonly
          :placeholder="t('knowledgeBase.noContent')"
        />
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.kb-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 12px;
  gap: 12px;
  overflow: hidden;
}

.kb-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.kb-panel-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.kb-loading,
.kb-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.kb-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 2px;
}

.kb-item {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  overflow: hidden;
  transition: border-color $transition-fast;

  &--expanded {
    border-color: $accent-muted;
  }
}

.kb-item-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: $text-primary;
  transition: background-color $transition-fast;

  &:hover {
    background: $bg-card-hover;
  }
}

.kb-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kb-item-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-item-desc {
  font-size: 11px;
  color: $text-muted;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-item-stats {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.kb-stat {
  font-size: 11px;
  color: $text-secondary;
  white-space: nowrap;
}

.kb-item-chevron {
  flex-shrink: 0;
  color: $text-muted;
  transition: transform 0.2s ease;

  &--open {
    transform: rotate(180deg);
  }
}

.kb-item-body {
  border-top: 1px solid $border-color;
  padding: 10px 12px;
}

.kb-doc-actions {
  margin-bottom: 8px;
}

.kb-doc-loading,
.kb-doc-empty {
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: $text-muted;
}

.kb-doc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kb-doc-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.02);
  position: relative;
}

.kb-doc-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.kb-doc-title {
  font-size: 12px;
  font-weight: 500;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-doc-status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.kb-doc-meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: $text-muted;
}

.kb-doc-error {
  font-size: 11px;
  color: $error;
  margin-top: 4px;
}

.kb-doc-delete {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  padding: 2px;
  transition: color $transition-fast;

  &:hover {
    color: $error;
  }
}

.kb-doc-actions-row {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.kb-doc-action-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  padding: 2px;
  transition: color $transition-fast;

  &:hover {
    color: $accent-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.kb-doc-type-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
}

.kb-search-bar {
  margin-bottom: 12px;
}

.kb-preview-content {
  min-height: 300px;
  max-height: 500px;
  overflow-y: auto;
}

.kb-item-footer {
  padding: 8px 12px;
  border-top: 1px solid $border-color;
  display: flex;
  justify-content: flex-end;
}

.kb-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.kb-form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  label {
    font-size: 12px;
    font-weight: 500;
    color: $text-secondary;
  }
}

.kb-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}
</style>
