<template>
  <div class="case-viewer">
    <n-page-header :title="pageTitle" :subtitle="fileInfo" @back="handleBack">
      <template #extra>
        <n-space>
          <n-button @click="handleExport" :loading="exporting">
            <template #icon>
              <n-icon><DownloadOutline /></n-icon>
            </template>
            导出 XMind
          </n-button>
          <n-button @click="handleFullscreen">
            <template #icon>
              <n-icon><ExpandOutline /></n-icon>
            </template>
            全屏
          </n-button>
        </n-space>
      </template>
    </n-page-header>

    <div class="case-viewer-content">
      <n-spin :show="loading" description="加载用例数据中...">
        <template v-if="hasError">
          <n-result status="error" title="加载失败" :description="errorMessage">
            <template #footer>
              <n-button @click="handleBack">返回</n-button>
            </template>
          </n-result>
        </template>
        <template v-else>
          <div ref="mindMapContainer" class="mindmap-container"></div>
        </template>
      </n-spin>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { DownloadOutline, ExpandOutline } from '@vicons/ionicons5'
import MindMap from 'simple-mind-map'
import Export from 'simple-mind-map/src/plugins/Export'
import ExportXMind from 'simple-mind-map/src/plugins/ExportXMind'
import MiniMap from 'simple-mind-map/src/plugins/MiniMap'
import Select from 'simple-mind-map/src/plugins/Select'
import xmind from 'simple-mind-map/src/parse/xmind'
import { getFileDownloadUrl } from '@/api/hermes/files'

// 注册插件
MindMap.usePlugin(Select)
MindMap.usePlugin(ExportXMind)
MindMap.usePlugin(MiniMap)
MindMap.usePlugin(Export)

const route = useRoute()
const router = useRouter()
const message = useMessage()

const mindMapContainer = ref<HTMLElement | null>(null)
const mindMap = ref<any>(null)
const loading = ref(true)
const hasError = ref(false)
const errorMessage = ref('')
const exporting = ref(false)
const xmindData = ref<any>(null)

const pageTitle = computed(() => {
  const path = route.query.path as string
  if (!path) return '用例查看'
  const fileName = path.split('/').pop() || path
  return fileName.replace('.xmind', '')
})

const fileInfo = computed(() => {
  const path = route.query.path as string
  return path || ''
})

const handleBack = () => {
  router.back()
}

const handleFullscreen = () => {
  const element = document.documentElement
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    element.requestFullscreen()
  }
}

const handleExport = async () => {
  if (!mindMap.value || !xmindData.value) {
    message.warning('暂无数据可导出')
    return
  }

  exporting.value = true
  try {
    const rootName = xmindData.value.root?.data?.text || '用例'
    await mindMap.value.export('xmind', true, rootName)
    message.success('导出成功')
  } catch (error: any) {
    message.error(`导出失败: ${error.message}`)
  } finally {
    exporting.value = false
  }
}

const initMindMap = (data: any) => {
  if (!mindMapContainer.value) {
    console.error('思维导图容器未找到')
    return
  }

  try {
    mindMap.value = new MindMap({
      el: mindMapContainer.value,
      data: data.root,
      layout: 'logicalStructure',
      mousewheelAction: 'zoom',
      mousewheelZoomActionReverse: false,
      initRootNodePosition: ['center', 'center'],
      enableAutoEnterTextEditWhenKeydown: false,
      enableCreateHiddenInput: false,
      isEndNodeTextEditOnClickOuter: true,
      enableFreeDrag: true,
      nodeTextEditZIndex: 10,
      useLeftKeySelectionRightKeyDrag: true,
    })

    // 设置主题配置
    mindMap.value.setThemeConfig({
      lineColor: '#4a90d9',
      lineWidth: 2,
      lineStyle: 'curve',
      nodeUseLineStyle: true,
      node: {
        marginX: 50,
        marginY: 30,
      },
    })

    // 监听渲染完成
    mindMap.value.on('node_tree_render_end', () => {
      loading.value = false
    })

    // 兜底超时
    setTimeout(() => {
      loading.value = false
    }, 5000)
  } catch (error: any) {
    console.error('初始化思维导图失败:', error)
    hasError.value = true
    errorMessage.value = `初始化失败: ${error.message}`
    loading.value = false
  }
}

const loadXmindFile = async () => {
  const path = route.query.path as string
  if (!path) {
    hasError.value = true
    errorMessage.value = '缺少文件路径参数'
    loading.value = false
    return
  }

  try {
    // 下载 xmind 文件
    const downloadUrl = getFileDownloadUrl(path)
    const response = await fetch(downloadUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const blob = await response.blob()
    const file = new File([blob], path.split('/').pop() || 'case.xmind', {
      type: 'application/xmind',
    })

    // 使用 simple-mind-map 的 xmind 解析器
    const parsedData = await xmind.parseXmindFile(file)
    xmindData.value = parsedData

    // 初始化思维导图
    initMindMap(parsedData)
  } catch (error: any) {
    console.error('加载 xmind 文件失败:', error)
    hasError.value = true
    errorMessage.value = `加载失败: ${error.message}`
    loading.value = false
  }
}

onMounted(() => {
  loadXmindFile()
})

onBeforeUnmount(() => {
  if (mindMap.value) {
    mindMap.value.destroy()
    mindMap.value = null
  }
})
</script>

<style scoped lang="scss">
.case-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);

  .case-viewer-content {
    flex: 1;
    position: relative;
    overflow: hidden;

    .mindmap-container {
      width: 100%;
      height: 100%;
      min-height: calc(100vh - 120px);
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);

      // 覆盖 simple-mind-map 默认样式
      :deep(svg) {
        width: 100%;
        height: 100%;
      }

      :deep(.smm-node) {
        .smm-node-text {
          font-size: 14px;
        }
      }
    }
  }
}
</style>
