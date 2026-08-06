import { overridesFilePath } from "./tool-descriptions.js";

/**
 * /config 页面 —— 在线编辑各 MCP 工具的描述。
 * 保存后到 Hermes Studio MCP 面板点 image-gen-demo 的「重载」即生效。
 */
export function renderConfigPage(): string {
  const file = overridesFilePath.replace(/\\/g, "\\\\");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>image-gen-demo · 工具描述配置</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; max-width: 920px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #888; font-size: 12px; margin-bottom: 20px; word-break: break-all; }
  .tool { border: 1px solid #e2e2e2; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: rgba(127,127,127,0.04); }
  .tool header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .tool h2 { font-size: 14px; margin: 0; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: #eef; color: #557; }
  .badge.overridden { background: #fef3c7; color: #92700a; }
  textarea { width: 100%; min-height: 64px; box-sizing: border-box; font: inherit; padding: 8px; border-radius: 6px; border: 1px solid #d4d4d4; resize: vertical; }
  .actions { margin-top: 16px; display: flex; gap: 8px; align-items: center; }
  button { font: inherit; padding: 7px 16px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; background: #fff; }
  button.primary { background: #7c3aed; color: #fff; border-color: #7c3aed; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status { font-size: 12px; color: #16a34a; min-height: 18px; }
  .reset { font-size: 11px; color: #7c3aed; background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; }
  .model-card { border: 1px solid #c4b5fd; border-radius: 8px; padding: 14px; margin-bottom: 16px; background: rgba(124,58,237,0.05); }
  .model-card header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .model-card h2 { font-size: 14px; margin: 0; }
  .model-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .model-grid label { display: flex; flex-direction: column; font-size: 12px; color: #555; gap: 4px; }
  .model-grid input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid #d4d4d4; }
  .model-actions { display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
  <h1>image-gen-demo · MCP 工具描述配置</h1>
  <div class="hint">编辑后点「保存全部」，再到 Hermes Studio 的 MCP 面板对 <code>image-gen-demo</code> 点「重载」即可生效。<br/>覆盖项写入：<span id="file">${file}</span></div>

  <section class="model-card">
    <header><h2>子 agent 独立模型配置</h2><span id="modelStatus" class="status"></span></header>
    <div class="model-grid">
      <label>API Key<input type="password" id="m_apiKey" placeholder="sk-…  留空则回退到 env / local 模式" autocomplete="off" /></label>
      <label>Base URL<input type="text" id="m_baseURL" placeholder="https://api.openai.com/v1" /></label>
      <label>Model<input type="text" id="m_model" placeholder="gpt-4o-mini" /></label>
      <label>Provider<input type="text" id="m_provider" placeholder="openai" /></label>
    </div>
    <div class="model-actions">
      <button class="primary" id="m_save">保存模型配置</button>
      <button id="m_clear">清空（回退到 env/默认）</button>
      <span id="modelInfo" class="status"></span>
    </div>
  </section>

  <div id="tools"></div>
  <div class="actions">
    <button class="primary" id="save" disabled>保存全部</button>
    <button id="resetAll" disabled>全部恢复默认</button>
    <span class="status" id="status"></span>
  </div>

<script>
const state = { tools: [], dirty: false };

async function load() {
  const r = await fetch('/api/tool-descriptions');
  const data = await r.json();
  state.tools = data.tools || [];
  render();
}

function render() {
  const root = document.getElementById('tools');
  root.innerHTML = '';
  for (const t of state.tools) {
    const div = document.createElement('div');
    div.className = 'tool';
    div.innerHTML = \`
      <header>
        <h2>\${t.name}</h2>
        <div>
          <span class="badge \${t.overridden ? 'overridden' : ''}">\${t.overridden ? '已覆盖' : '默认'}</span>
          <button class="reset" data-name="\${t.name}">恢复默认</button>
        </div>
      </header>
      <textarea data-name="\${t.name}" placeholder="\${t.defaultDescription}">\${t.description ?? ''}</textarea>
    \`;
    root.appendChild(div);
  }
  root.querySelectorAll('textarea').forEach(ta => {
    ta.addEventListener('input', () => {
      state.dirty = true;
      document.getElementById('save').disabled = false;
      document.getElementById('status').textContent = '有未保存的改动';
    });
  });
  root.querySelectorAll('.reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const ta = root.querySelector(\`textarea[data-name="\${name}"]\`);
      ta.value = state.tools.find(t => t.name === name).defaultDescription;
      ta.dispatchEvent(new Event('input'));
    });
  });
  document.getElementById('resetAll').disabled = state.tools.length === 0;
}

async function save() {
  const map = {};
  document.querySelectorAll('textarea[data-name]').forEach(ta => { map[ta.dataset.name] = ta.value; });
  document.getElementById('save').disabled = true;
  const r = await fetch('/api/tool-descriptions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(map) });
  if (r.ok) {
    state.dirty = false;
    document.getElementById('status').textContent = '已保存 ✓  去 Hermes Studio MCP 面板重载 image-gen-demo';
    await load();
  } else {
    document.getElementById('status').textContent = '保存失败：' + (await r.text());
    document.getElementById('save').disabled = false;
  }
}

function resetAll() {
  if (!confirm('全部恢复为默认描述？')) return;
  document.querySelectorAll('textarea[data-name]').forEach(ta => {
    ta.value = state.tools.find(t => t.name === ta.dataset.name).defaultDescription;
  });
  state.dirty = true;
  document.getElementById('save').disabled = false;
  document.getElementById('status').textContent = '有未保存的改动';
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('resetAll').addEventListener('click', resetAll);

// ── 子 agent 独立模型配置 ──
async function loadModel() {
  const r = await fetch('/api/model-config');
  const m = await r.json();
  document.getElementById('m_baseURL').value = m.baseURL || '';
  document.getElementById('m_model').value = m.model || '';
  document.getElementById('m_provider').value = m.provider || '';
  document.getElementById('m_apiKey').value = '';
  document.getElementById('m_apiKey').placeholder = m.hasApiKey ? \`已配置（\${m.apiKeyMasked}）— 留空保持不变\` : 'sk-…  留空则回退到 env / local 模式';
  const sourceLabel = { page: '页面独立配置', env: '环境变量', hermes: '继承主 agent（hermes config.yaml）', default: '默认（local 兜底）' }[m.source] || m.source;
  document.getElementById('modelInfo').textContent = \`当前：\${m.mode} 模式 · \${sourceLabel} · \${m.apiMode || 'openai'} · \${m.baseURL} · \${m.model}\${m.hasApiKey ? '（' + m.apiKeyMasked + '）' : ''}\`;
}
async function saveModel() {
  const apiKey = document.getElementById('m_apiKey').value;
  const body = {
    baseURL: document.getElementById('m_baseURL').value,
    model: document.getElementById('m_model').value,
    provider: document.getElementById('m_provider').value,
  };
  if (apiKey) body.apiKey = apiKey;
  const r = await fetch('/api/model-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('modelStatus').textContent = r.ok ? '已保存 ✓  到 Hermes MCP 面板重载 image-gen-demo 生效' : '保存失败';
  await loadModel();
}
async function clearModel() {
  if (!confirm('清空页面模型配置？将回退到环境变量 / 默认（local 模式）。')) return;
  await fetch('/api/model-config', { method: 'DELETE' });
  document.getElementById('modelStatus').textContent = '已清空 ✓';
  await loadModel();
}
document.getElementById('m_save').addEventListener('click', saveModel);
document.getElementById('m_clear').addEventListener('click', clearModel);
loadModel();

load();
</script>
</body>
</html>`;
}
