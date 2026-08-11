import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, type Component } from "vue";
import { useI18n } from "vue-i18n";

/**
 * 内联管理面板（skills / plugins / mcp / delegation / knowledgeBase / jobs）。
 *
 * PageSidebarNav 通过 window 事件 `hermes:navigate-manage` 请求打开管理面板，
 * 宿主（ChatPanel / GroupChatPanel / HistoryView）调用本 composable 监听该事件，
 * 把管理面板以覆盖层形式内联渲染在当前页面上，而不是路由跳转走 ——
 * 这样底下的对话状态（滚动位置、输入草稿等）得以保留，返回时回到原状态。
 */
export type InlineManageView =
  | "skills"
  | "plugins"
  | "mcp"
  | "delegation"
  | "knowledgeBase"
  | "jobs";

// 模块级共享：异步组件只加载一次，多个宿主复用同一 loader。
const COMPONENT_MAP: Record<InlineManageView, Component> = {
  skills: defineAsyncComponent(() => import("@/views/hermes/SkillsView.vue").then((m) => m.default)),
  plugins: defineAsyncComponent(() => import("@/views/hermes/PluginsView.vue").then((m) => m.default)),
  mcp: defineAsyncComponent(() => import("@/views/hermes/MCPManagerView.vue").then((m) => m.default)),
  delegation: defineAsyncComponent(() =>
    import("@/components/hermes/chat/DelegationPanel.vue").then((m) => m.default),
  ),
  knowledgeBase: defineAsyncComponent(() =>
    import("@/components/hermes/chat/KnowledgeBasePanel.vue").then((m) => m.default),
  ),
  jobs: defineAsyncComponent(() => import("@/views/hermes/JobsView.vue").then((m) => m.default)),
};

const VALID_PANELS = new Set<InlineManageView>([
  "skills",
  "plugins",
  "mcp",
  "delegation",
  "knowledgeBase",
  "jobs",
]);

export function useManageInlineView() {
  const { t } = useI18n();
  const inlineView = ref<InlineManageView | null>(null);

  const inlineViewComponent = computed<Component | null>(() =>
    inlineView.value ? COMPONENT_MAP[inlineView.value] : null,
  );

  const inlineViewTitle = computed(() => {
    switch (inlineView.value) {
      case "skills":
        return t("sidebar.skills");
      case "plugins":
        return t("sidebar.plugins");
      case "mcp":
        return t("sidebar.mcp");
      case "delegation":
        return t("delegation.title");
      case "knowledgeBase":
        return t("knowledgeBase.title");
      case "jobs":
        return t("sidebar.jobs");
      default:
        return "";
    }
  });

  function closeInlineView() {
    inlineView.value = null;
  }

  function handleNavigateManage(event: Event) {
    const detail = (event as CustomEvent<{ panel: string }>).detail;
    if (!detail) return;
    if (VALID_PANELS.has(detail.panel as InlineManageView)) {
      event.preventDefault();
      inlineView.value = detail.panel as InlineManageView;
    }
  }

  onMounted(() => {
    window.addEventListener("hermes:navigate-manage", handleNavigateManage);
  });
  onUnmounted(() => {
    window.removeEventListener("hermes:navigate-manage", handleNavigateManage);
  });

  return {
    inlineView,
    inlineViewComponent,
    inlineViewTitle,
    closeInlineView,
    handleNavigateManage,
  };
}
