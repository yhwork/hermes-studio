<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { NBadge, NButton, NDrawer, NDrawerContent, NInput, NSelect, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SkillList from '@/components/hermes/skills/SkillList.vue'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillImportModal from '@/components/hermes/skills/SkillImportModal.vue'
import SkillExternalDirsModal from '@/components/hermes/skills/SkillExternalDirsModal.vue'
import PendingWriteApprovals from '@/components/hermes/skills/PendingWriteApprovals.vue'
import { fetchSkills, type SkillCategory, type SkillSource, type SkillInfo, type SkillTarget } from '@/api/hermes/skills'
import { fetchPendingWrites } from '@/api/hermes/write-gate'
import { useProfilesStore } from '@/stores/hermes/profiles'

type SourceFilter = SkillSource | 'modified'

const { t } = useI18n()
const profilesStore = useProfilesStore()
const categories = ref<SkillCategory[]>([])
const archived = ref<SkillInfo[]>([])
const loading = ref(false)
const selectedCategory = ref('')
const selectedSkill = ref('')
const searchQuery = ref('')
const showSidebar = ref(true)
const sourceFilter = ref<SourceFilter | null>(null)
const skillTarget = ref<SkillTarget>('hermes')
const showImportModal = ref(false)
const showExternalDirsModal = ref(false)
const showWriteApprovalDrawer = ref(false)
const pendingWriteCount = ref(0)
const writeApprovalSupported = ref(true)
let mobileQuery: MediaQueryList | null = null

const selectedSkillData = computed(() => {
  if (!selectedCategory.value || !selectedSkill.value) return null
  if (selectedCategory.value === '.archive') {
    return archived.value.find(s => s.name === selectedSkill.value) ?? null
  }
  const cat = categories.value.find(c => c.name === selectedCategory.value)
  return cat?.skills.find(s => s.name === selectedSkill.value) ?? null
})

const skillTargetOptions = computed(() => [
  { label: t('skills.targets.hermes'), value: 'hermes' },
  { label: t('skills.targets.claude'), value: 'claude' },
  { label: t('skills.targets.codex'), value: 'codex' },
])

const isHermesTarget = computed(() => skillTarget.value === 'hermes')
const selectedSkillReadonly = computed(() => {
  if (!selectedSkillData.value) return true
  if (selectedCategory.value === '.archive') return true
  return (selectedSkillData.value.source || 'local') !== 'local'
})

// 技能统计
const skillStats = computed(() => {
  let total = 0
  let builtin = 0
  let hub = 0
  let local = 0
  let external = 0
  let modified = 0

  categories.value.forEach(cat => {
    cat.skills.forEach(skill => {
      total++
      if (skill.modified) modified++
      const source = skill.source || 'local'
      if (source === 'builtin') builtin++
      else if (source === 'hub') hub++
      else if (source === 'local') local++
      else if (source === 'external') external++
    })
  })

  return { total, builtin, hub, local, external, modified }
})

// 搜索结果计数
const searchResultCount = computed(() => {
  if (!searchQuery.value) return null
  let count = 0
  const query = searchQuery.value.toLowerCase()
  
  categories.value.forEach(cat => {
    cat.skills.forEach(skill => {
      if (skill.name.toLowerCase().includes(query) || 
          (skill.description && skill.description.toLowerCase().includes(query))) {
        count++
      }
    })
  })
  
  return count
})

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  showSidebar.value = !e.matches
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  loadSkills()
  loadPendingWriteCount()
  
  // 添加键盘快捷键
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
  window.removeEventListener('keydown', handleKeydown)
})

function handleKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + F 聚焦搜索
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    const searchInput = document.querySelector('.skills-search-input input') as HTMLInputElement
    searchInput?.focus()
  }
  // Esc 清除搜索
  if (e.key === 'Escape' && searchQuery.value) {
    searchQuery.value = ''
  }
}

async function loadSkills() {
  loading.value = true
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    const data = await fetchSkills(undefined, skillTarget.value)
    categories.value = data.categories
    archived.value = data.archived
    ensureSelectedSkill()
  } catch (err: any) {
    console.error('Failed to load skills:', err)
  } finally {
    loading.value = false
  }
}

function handleTargetChange() {
  selectedCategory.value = ''
  selectedSkill.value = ''
  sourceFilter.value = null
  loadSkills()
  if (skillTarget.value === 'hermes') loadPendingWriteCount()
}

async function loadPendingWriteCount() {
  try {
    const data = await fetchPendingWrites()
    writeApprovalSupported.value = data.supported !== false
    pendingWriteCount.value = writeApprovalSupported.value ? data.records?.length || 0 : 0
  } catch (err) {
    console.error('Failed to load pending write approvals:', err)
  }
}

function ensureSelectedSkill() {
  const currentCategory = categories.value.find(c => c.name === selectedCategory.value)
  if (currentCategory?.skills.some(s => s.name === selectedSkill.value)) return

  const firstCategory = categories.value.find(c => c.skills.length > 0)
  const firstSkill = firstCategory?.skills[0]
  selectedCategory.value = firstCategory?.name || ''
  selectedSkill.value = firstSkill?.name || ''
}

function toggleFilter(filter: SourceFilter) {
  sourceFilter.value = sourceFilter.value === filter ? null : filter
}

function handleSelect(category: string, skill: string) {
  if (selectedCategory.value === category && selectedSkill.value === skill) {
    return
  }
  selectedCategory.value = category
  selectedSkill.value = skill
  if (window.innerWidth <= 768) {
    showSidebar.value = false
  }
}

function handleSkillDeleted(category: string, skillName: string) {
  if (selectedCategory.value === category && selectedSkill.value === skillName) {
    selectedCategory.value = ''
    selectedSkill.value = ''
  }
  loadSkills()
}

function handleImported() {
  showImportModal.value = false
  loadSkills()
}

function handleExternalDirsSaved() {
  showExternalDirsModal.value = false
  loadSkills()
}

function handlePinToggled(name: string, pinned: boolean) {
  // Update local state so the pin icon updates immediately
  if (selectedCategory.value === '.archive') {
    const skill = archived.value.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  } else {
    const cat = categories.value.find(c => c.name === selectedCategory.value)
    const skill = cat?.skills.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  }
}

function handleSkillSaved() {
  loadSkills()
}
</script>

<template>
  <div class="skills-view">
    <header class="page-header">
      <div class="header-left">
        <h2 class="header-title">{{ t('skills.title') }}</h2>
        <NTag v-if="!loading" size="small" :bordered="false" type="info">
          {{ skillStats.total }}
        </NTag>
        <button v-if="!showSidebar" class="sidebar-toggle" @click="showSidebar = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
      </div>
      
      <div class="source-legend">
        <button class="legend-item" :class="{ active: sourceFilter === 'builtin' }" @click="toggleFilter('builtin')">
          <span class="legend-dot dot-builtin" />
          <span>{{ t('skills.source.builtin') }}</span>
          <NTag v-if="skillStats.builtin > 0" size="tiny" :bordered="false">{{ skillStats.builtin }}</NTag>
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'hub' }" @click="toggleFilter('hub')">
          <span class="legend-dot dot-hub" />
          <span>{{ t('skills.source.hub') }}</span>
          <NTag v-if="skillStats.hub > 0" size="tiny" :bordered="false">{{ skillStats.hub }}</NTag>
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'local' }" @click="toggleFilter('local')">
          <span class="legend-dot dot-local" />
          <span>{{ t('skills.source.local') }}</span>
          <NTag v-if="skillStats.local > 0" size="tiny" :bordered="false">{{ skillStats.local }}</NTag>
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'external' }" @click="toggleFilter('external')">
          <span class="legend-dot dot-external" />
          <span>{{ t('skills.source.external') }}</span>
          <NTag v-if="skillStats.external > 0" size="tiny" :bordered="false">{{ skillStats.external }}</NTag>
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'modified' }" @click="toggleFilter('modified')">
          <span class="modified-icon">✎</span>
          <span>{{ t('skills.modified') }}</span>
          <NTag v-if="skillStats.modified > 0" size="tiny" :bordered="false" type="warning">{{ skillStats.modified }}</NTag>
        </button>
      </div>
      
      <div class="header-actions">
        <div class="search-container">
          <NInput
            v-model:value="searchQuery"
            :placeholder="t('skills.searchPlaceholder')"
            size="small"
            clearable
            class="skills-search-input"
            style="width: 200px"
          >
            <template #prefix>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <path d="m21 21-4.3-4.3"/>
              </svg>
            </template>
            <template #suffix>
              <transition name="fade">
                <span v-if="searchQuery && searchResultCount !== null" class="search-count">
                  {{ searchResultCount }}
                </span>
              </transition>
            </template>
          </NInput>
          <span class="search-hint">Ctrl+F</span>
        </div>
        
        <NButton
          v-if="isHermesTarget"
          class="header-action-btn"
          size="small"
          :title="t('skills.import')"
          @click="showImportModal = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </template>
          <span class="header-action-label">{{ t('skills.import') }}</span>
        </NButton>
        
        <NButton
          v-if="isHermesTarget"
          class="header-action-btn"
          size="small"
          :title="t('skills.externalDirs.manage')"
          @click="showExternalDirsModal = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </template>
          <span class="header-action-label">{{ t('skills.externalDirs.manage') }}</span>
        </NButton>
        
        <NButton
          v-if="isHermesTarget && writeApprovalSupported"
          class="header-action-btn"
          size="small"
          :title="t('skills.writeApprovalTitle')"
          @click="showWriteApprovalDrawer = true"
        >
          <template #icon>
            <NBadge :value="pendingWriteCount" :max="99" :show="pendingWriteCount > 0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
            </NBadge>
          </template>
          <span class="header-action-label">
            {{ t('skills.writeApprovalButton', { count: pendingWriteCount }) }}
          </span>
        </NButton>
      </div>
    </header>

    <SkillImportModal v-if="showImportModal" @close="showImportModal = false" @saved="handleImported" />
    <SkillExternalDirsModal v-if="showExternalDirsModal"
      @close="showExternalDirsModal = false" @saved="handleExternalDirsSaved" />
    <NDrawer
      v-model:show="showWriteApprovalDrawer"
      width="min(960px, calc(100vw - 32px))"
      placement="right"
      class="write-approval-drawer"
    >
      <NDrawerContent :title="t('skills.writeApprovalTitle')" closable>
        <PendingWriteApprovals
          v-if="showWriteApprovalDrawer"
          @count-change="(count) => pendingWriteCount = count"
        />
      </NDrawerContent>
    </NDrawer>

    <div class="skills-content">
      <transition name="fade-slide" mode="out-in">
        <div v-if="loading && categories.length === 0" key="loading" class="skills-loading">
          <div class="loading-spinner"></div>
          <span>{{ t('common.loading') }}</span>
        </div>
        
        <div v-else key="content" class="skills-layout">
          <div class="mobile-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
          
          <transition name="slide-left">
            <div v-if="showSidebar" class="skills-sidebar">
              <div class="skills-target-filter">
                <span class="target-filter-label">{{ t('skills.targetFilter') }}</span>
                <NSelect
                  v-model:value="skillTarget"
                  size="small"
                  :options="skillTargetOptions"
                  @update:value="handleTargetChange"
                />
              </div>
              <SkillList
                :categories="categories"
                :archived="archived"
                :selected-skill="selectedCategory && selectedSkill ? `${selectedCategory}/${selectedSkill}` : null"
                :search-query="searchQuery"
                :source-filter="sourceFilter"
                :readonly="!isHermesTarget"
                @select="handleSelect"
                @deleted="handleSkillDeleted"
              />
            </div>
          </transition>
          
          <div class="skills-main">
            <transition name="fade-slide" mode="out-in">
              <SkillDetail
                v-if="selectedCategory && selectedSkill"
                :key="`${selectedCategory}/${selectedSkill}`"
                :category="selectedCategory"
                :skill="selectedSkill"
                :skill-name="selectedSkillData?.name || selectedSkill"
                :patch-count="selectedSkillData?.patchCount"
                :use-count="selectedSkillData?.useCount"
                :view-count="selectedSkillData?.viewCount"
                :pinned="selectedSkillData?.pinned"
                :target="skillTarget"
                :readonly="selectedSkillReadonly"
                :can-pin="isHermesTarget"
                @pin-toggled="handlePinToggled"
                @saved="handleSkillSaved"
              />
              
              <div v-else key="empty" class="empty-detail">
                <div class="empty-icon">
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                  </svg>
                </div>
                <div class="empty-content">
                  <h3>{{ t('skills.noSkillSelected') }}</h3>
                  <p>{{ t('skills.selectToView') }}</p>
                </div>
              </div>
            </transition>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skills-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: $bg-primary;
}

.page-header {
  padding: 12px 20px;
  border-bottom: 1px solid $border-color;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  background: $bg-secondary;
  backdrop-filter: blur(10px);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-title {
  font-size: 18px;
  font-weight: 700;
  color: $text-primary;
  margin: 0;
  letter-spacing: -0.3px;
}

.source-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
  margin-inline-start: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-container {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}

.search-hint {
  font-size: 10px;
  color: $text-muted;
  background: $bg-secondary;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid $border-color;
  white-space: nowrap;
  opacity: 0.7;
}

.search-count {
  font-size: 11px;
  color: $text-secondary;
  background: rgba(var(--accent-primary-rgb), 0.1);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}

.skills-target-filter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 8px 10px;
  border-bottom: 1px solid $border-light;
}

.target-filter-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: $text-muted;
  white-space: nowrap;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.05);
    border-color: rgba(var(--accent-primary-rgb), 0.1);
  }

  &.active {
    color: $accent-primary;
    border-color: rgba(var(--accent-primary-rgb), 0.3);
    background: rgba(var(--accent-primary-rgb), 0.08);
    font-weight: 600;
  }
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.1);
}

.legend-dot.dot-builtin { background: $text-muted; }
.legend-dot.dot-hub { background: #4a90d9; }
.legend-dot.dot-local { background: #66bb6a; }
.legend-dot.dot-external { background: #f59e0b; }

.modified-icon {
  font-size: 12px;
  color: #f59e0b;
  opacity: 0.9;
}

@media (max-width: $breakpoint-mobile) {
  .source-legend {
    display: none;
  }

  .header-action-label {
    display: none;
  }

  .header-action-btn {
    width: 30px;
    padding: 0;

    :deep(.n-button__content) {
      justify-content: center;
    }

    :deep(.n-button__icon) {
      margin: 0;
    }
  }
}

.search-input {
  width: 100px;

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
  }
}

.skills-content {
  flex: 1;
  overflow: hidden;
}

.skills-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  height: 100%;
  color: $text-muted;

  .loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(var(--accent-primary-rgb), 0.15);
    border-top-color: $accent-primary;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  span {
    font-size: 13px;
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.skills-layout {
  display: flex;
  height: 100%;
  position: relative;
}

.skills-sidebar {
  width: 280px;
  border-inline-end: 1px solid $border-color;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  background: $bg-card;
}

.skills-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-width: 0;
}

.sidebar-toggle {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

.empty-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: $text-muted;

  .empty-icon {
    opacity: 0.2;
    color: $text-muted;
    margin-bottom: 4px;
  }

  .empty-content {
    text-align: center;

    h3 {
      font-size: 16px;
      font-weight: 600;
      color: $text-secondary;
      margin: 0 0 6px 0;
    }

    p {
      font-size: 13px;
      color: $text-muted;
      margin: 0;
    }
  }
}

// Transitions
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.slide-left-enter-active,
.slide-left-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.slide-left-enter-from,
.slide-left-leave-to {
  transform: translateX(-16px);
  opacity: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: $breakpoint-mobile) {
  .sidebar-toggle {
    display: flex;
  }

  .skills-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 10;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
  }

  .skills-layout {
    position: relative;
  }

  .mobile-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 9;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .search-hint {
    display: none;
  }
}

</style>
