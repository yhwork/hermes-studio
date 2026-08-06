<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionSearch } from '@/composables/useSessionSearch'

type ActiveSection = 'chat' | 'history' | 'group' | 'global' | 'workflow'

const props = defineProps<{
  active: ActiveSection
  primaryLabel?: string
  hideModeSwitch?: boolean
  showDelegation?: boolean
  showKnowledgeBase?: boolean
}>()

const emit = defineEmits<{
  primary: []
}>()

const { t } = useI18n()
const router = useRouter()
const { openSessionSearch } = useSessionSearch()

const primaryText = computed(() => props.primaryLabel || t('chat.newChat'))
const showModeSwitch = computed(() => !props.hideModeSwitch)
const historyButtonLabel = computed(() =>
  props.active === 'history' ? t('chat.sessions') : t('sidebar.history'),
)

function openChat() {
  if (props.active === 'chat') return
  void router.push({ name: 'hermes.chat' })
}

function openHistory() {
  // In chat view, "历史" toggles the session sidebar instead of navigating.
  // This avoids a full-page route switch that would collapse the left sidebar.
  const event = new CustomEvent('hermes:toggle-session-sidebar', { cancelable: true })
  if (!window.dispatchEvent(event)) return // ChatPanel handled it
  // Fallback for non-chat hosts: navigate to the history route
  if (props.active === 'history') {
    void router.push({ name: 'hermes.chat' })
    return
  }
  void router.push({ name: 'hermes.history' })
}

function openGroupChat() {
  if (props.active === 'group') return
  void router.push({ name: 'hermes.groupChat' })
}

function openWorkflow() {
  if (props.active === 'workflow') return
  void router.push({ name: 'hermes.workflow' })
}

// Emit a cancelable window event so a host (e.g. ChatPanel) can open the
// management view inline without leaving the current page. If no listener
// calls preventDefault(), fall back to a normal route navigation so other
// hosts keep working. `delegation` has no route — it is inline-only.
type ManagePanel = 'skills' | 'plugins' | 'mcp' | 'delegation' | 'knowledgeBase' | 'jobs'

function emitNavigateManage(panel: ManagePanel): boolean {
  const event = new CustomEvent('hermes:navigate-manage', {
    detail: { panel },
    cancelable: true,
  })
  // dispatchEvent returns false when a listener called preventDefault().
  return !window.dispatchEvent(event)
}

function dispatchNavigateManage(panel: ManagePanel) {
  if (emitNavigateManage(panel)) return
  if (panel === 'delegation' || panel === 'knowledgeBase' || panel === 'jobs' || panel === 'history') return
  void router.push({ name: `hermes.${panel}` })
}

function openJobs() {
  dispatchNavigateManage('jobs')
}

function openSkills() {
  dispatchNavigateManage('skills')
}

function openPlugins() {
  dispatchNavigateManage('plugins')
}

function openMcp() {
  dispatchNavigateManage('mcp')
}

function openDelegation() {
  dispatchNavigateManage('delegation')
}

function openKnowledgeBase() {
  dispatchNavigateManage('knowledgeBase')
}
</script>

<template>
  <div class="page-sidebar-nav">
    <div class="page-sidebar-tabs" role="tablist" aria-label="Chat actions">
      <button
        class="page-sidebar-tab"
        type="button"
        @click="emit('primary')"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>{{ primaryText }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openSessionSearch">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>{{ t('sidebar.search') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        type="button"
        @click="openHistory"
      >
        <svg
          v-if="active === 'history'"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <svg
          v-else
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>{{ historyButtonLabel }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openJobs">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span>{{ t('sidebar.jobs') }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openSkills">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
        <span>{{ t('sidebar.skills') }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openPlugins">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l2.1-2.1a4 4 0 0 1-5.3 5.3l-7.8 7.8a2.1 2.1 0 0 1-3-3l7.8-7.8a4 4 0 0 1 5.3-5.3l-2.1 2.1z" />
          <path d="M5 19l1-1" />
        </svg>
        <span>{{ t('sidebar.plugins') }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openMcp">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 7v13" />
          <rect x="4" y="7" width="16" height="7" rx="2" />
        </svg>
        <span>{{ t('sidebar.mcp') }}</span>
      </button>
      <button v-if="showDelegation" class="page-sidebar-tab" type="button" @click="openDelegation">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="2" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="M12 7v4" />
          <path d="M12 11l-5 6" />
          <path d="M12 11l5 6" />
        </svg>
        <span>{{ t('sidebar.delegation') }}</span>
      </button>
      <button v-if="showKnowledgeBase" class="page-sidebar-tab" type="button" @click="openKnowledgeBase">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <line x1="8" y1="7" x2="16" y2="7" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
        <span>{{ t('sidebar.knowledgeBase') }}</span>
      </button>
    </div>
    <div v-if="showModeSwitch" class="conversation-switch conversation-switch--three" role="tablist" aria-label="Conversation type">
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'chat' || active === 'history' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.singleChat')"
            :aria-selected="active === 'chat' || active === 'history'"
            @click="openChat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.singleChat') }}
      </NTooltip>
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'group' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.groupChat')"
            :aria-selected="active === 'group'"
            @click="openGroupChat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.groupChat') }}
      </NTooltip>
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'workflow' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.workflow')"
            :aria-selected="active === 'workflow'"
            @click="openWorkflow"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="5" cy="12" r="3" />
              <circle cx="19" cy="6" r="3" />
              <circle cx="19" cy="18" r="3" />
              <path d="M8 12h3a4 4 0 0 0 4-4V6" />
              <path d="M8 12h3a4 4 0 0 1 4 4v2" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.workflow') }}
      </NTooltip>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover,
  &.active {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.conversation-switch-tab {
  width: 100%;
  min-width: 0;
  height: 30px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex: 0 0 auto;
  }

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}

:global(.dark .conversation-switch--three .conversation-switch-tab.active) {
  background: $bg-card-hover;
  color: $accent-primary;
  box-shadow:
    inset 0 0 0 1px $border-color,
    0 2px 5px rgba(0, 0, 0, 0.22);
}
</style>
