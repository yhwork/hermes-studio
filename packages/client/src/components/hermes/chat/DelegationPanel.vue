<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore, type SubagentStream, type SubagentStreamStatus } from '@/stores/hermes/chat'
import { openSubagentStream } from '@/utils/hermes/subagent-stream'

const { t } = useI18n()
const chatStore = useChatStore()

const sessionId = computed(() => chatStore.activeSessionId)

// All sub-agent delegations belonging to the active chat session, newest first.
const streams = computed<SubagentStream[]>(() => {
  const sid = sessionId.value
  if (!sid) return []
  return [...chatStore.subagentStreams.values()]
    .filter(stream => stream.sessionId === sid)
    .sort((a, b) => b.startedAt - a.startedAt)
})

const runningCount = computed(
  () => streams.value.filter(stream => stream.status === 'running').length,
)

function statusLabel(status: SubagentStreamStatus): string {
  const key = `subagent.${status}`
  const label = t(key)
  // Fall back to the raw status if no translation is registered.
  return label === key ? status : label
}

function formatDuration(seconds?: number): string {
  if (seconds == null) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

function formatCount(value?: number): string {
  if (value == null) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatCost(cost?: number): string {
  if (cost == null) return ''
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return t('delegation.justNow')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('delegation.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('delegation.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('delegation.daysAgo', { count: days })
}

function openStream(stream: SubagentStream) {
  // Reuses the existing subagent-stream overlay: dispatches the window event
  // that ChatPanel listens for. ChatPanel closes this inline panel and shows
  // the live sub-agent output in the tool panel.
  openSubagentStream(stream.sessionId, `subagent:${stream.subagentId}`)
}
</script>

<template>
  <div class="delegation-panel">
    <div v-if="streams.length > 0" class="delegation-panel-summary">
      <span class="delegation-summary-count">
        {{ t('delegation.count', { count: streams.length }) }}
      </span>
      <span v-if="runningCount > 0" class="delegation-summary-running">
        {{ t('delegation.runningCount', { count: runningCount }) }}
      </span>
    </div>

    <div v-if="streams.length === 0" class="delegation-empty">
      {{ sessionId ? t('delegation.empty') : t('delegation.noSession') }}
    </div>

    <div v-else class="delegation-list">
      <button
        v-for="stream in streams"
        :key="stream.subagentId"
        class="delegation-item"
        type="button"
        :title="t('delegation.viewStream')"
        @click="openStream(stream)"
      >
        <div class="delegation-item-header">
          <span class="delegation-status" :class="`delegation-status--${stream.status}`">
            <span class="delegation-status-dot" />
            {{ statusLabel(stream.status) }}
          </span>
          <span class="delegation-task-pos">
            {{ t('delegation.taskPosition', { index: stream.taskIndex + 1, count: Math.max(1, stream.taskCount) }) }}
          </span>
          <span class="delegation-time">{{ relativeTime(stream.startedAt) }}</span>
        </div>
        <div class="delegation-goal">{{ stream.goal || t('subagent.noGoal') }}</div>
        <div v-if="stream.summary" class="delegation-summary-text">{{ stream.summary }}</div>
        <div class="delegation-meta">
          <span v-if="stream.durationSeconds != null" class="delegation-meta-item">
            {{ formatDuration(stream.durationSeconds) }}
          </span>
          <span v-if="stream.toolCount != null" class="delegation-meta-item">
            {{ t('subagent.tools', { count: stream.toolCount }) }}
          </span>
          <span
            v-if="stream.inputTokens != null || stream.outputTokens != null"
            class="delegation-meta-item"
          >
            {{ t('subagent.tokens', {
              input: formatCount(stream.inputTokens || 0),
              output: formatCount(stream.outputTokens || 0),
            }) }}
          </span>
          <span v-if="stream.costUsd != null" class="delegation-meta-item">
            {{ t('delegation.cost', { cost: formatCost(stream.costUsd) }) }}
          </span>
          <span v-if="stream.model" class="delegation-meta-item delegation-model">
            {{ stream.model }}
          </span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.delegation-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 12px;
  gap: 10px;
  overflow: hidden;
}

.delegation-panel-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  font-size: 12px;
  color: $text-muted;
}

.delegation-summary-running {
  color: var(--accent-info);
}

.delegation-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  font-size: 13px;
  color: $text-muted;
  line-height: 1.6;
}

.delegation-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.delegation-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  cursor: pointer;
  transition:
    border-color $transition-fast,
    background-color $transition-fast;

  &:hover {
    border-color: $accent-muted;
    background: $bg-card-hover;
  }
}

.delegation-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.delegation-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: $text-secondary;

  &--running { color: var(--accent-info); }
  &--completed { color: $success; }
  &--failed,
  &--error { color: $error; }
  &--cancelled,
  &--interrupted { color: $text-muted; }
}

.delegation-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.delegation-status--running .delegation-status-dot {
  animation: delegation-pulse 1.4s ease-in-out infinite;
}

@keyframes delegation-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.delegation-task-pos {
  color: $text-muted;
}

.delegation-time {
  margin-left: auto;
  color: $text-muted;
}

.delegation-goal {
  font-size: 13px;
  color: $text-primary;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.delegation-summary-text {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.delegation-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  color: $text-muted;
}

.delegation-meta-item {
  white-space: nowrap;
}

.delegation-model {
  font-family: $font-code;
}
</style>
