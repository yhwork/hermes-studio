<script setup lang="ts">
import type { Component } from "vue";
import { useI18n } from "vue-i18n";

/**
 * 内联管理面板覆盖层 —— 以 `position: absolute; inset: 0` 覆盖在宿主的
 * `.chat-main`（需 `position: relative`）之上，底下的对话内容保持挂载不卸载，
 * 关闭后回到原对话状态。配合 `useManageInlineView` 使用。
 */
defineProps<{
  title: string;
  component: Component | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="component" class="manage-inline-panel">
    <header class="manage-inline-panel-header">
      <button
        class="manage-inline-back"
        type="button"
        :title="t('realtimeVoice.back')"
        @click="emit('close')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>{{ t("realtimeVoice.back") }}</span>
      </button>
      <span class="manage-inline-panel-title">{{ title }}</span>
    </header>
    <div class="manage-inline-panel-body">
      <component :is="component" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.manage-inline-panel {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: $bg-main-surface;
  border-radius: inherit;
  overflow: hidden;
}

.manage-inline-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 1px solid $border-color;
  background: $bg-card;
}

.manage-inline-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.manage-inline-panel-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.manage-inline-panel-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
