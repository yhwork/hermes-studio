#!/usr/bin/env bash
# start.sh — Hermes Studio 本地开发启动脚本
#
# 对应 docs/项目启动指南.md 第 2-3 节：
#   1. 前置检查（Node ≥23、npm、项目根目录）
#   2. 依赖检查（node_modules 缺失则自动 npm install）
#   3. 端口检查（8649 前端 / 8647 后端 / 15721 cc-switch）
#   4. 启动开发模式（npm run dev，前后端同时拉起）
#
# 用法：
#   bash scripts/start.sh            # 检查环境并启动开发模式
#   bash scripts/start.sh --check    # 仅检查环境，不启动
#   bash scripts/start.sh --no-install  # 缺依赖时不自动安装
#   bash scripts/start.sh --help     # 查看帮助

set -uo pipefail

# ---- 配置 ----
FRONTEND_PORT=8649
BACKEND_PORT=8647
CCSWITCH_PORT=15721
MIN_NODE_MAJOR=23

# ---- 颜色输出 ----
if [ -t 1 ]; then
  C_INFO='\033[36m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_OFF='\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
fi
info() { printf "${C_INFO}ℹ️  %s${C_OFF}\n" "$*"; }
ok()   { printf "${C_OK}✅ %s${C_OFF}\n" "$*"; }
warn() { printf "${C_WARN}⚠️  %s${C_OFF}\n" "$*"; }
err()  { printf "${C_ERR}❌ %s${C_OFF}\n" "$*"; }
die()  { err "$*"; exit 1; }

# ---- 解析参数 ----
CHECK_ONLY=0
AUTO_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --check)      CHECK_ONLY=1 ;;
    --no-install) AUTO_INSTALL=0 ;;
    -h|--help)    sed -n '2,15p' "$0"; exit 0 ;;
    *) die "未知参数: $arg (用 --help 查看用法)" ;;
  esac
done

# ---- 工具函数 ----
# 检查端口是否被监听（跨平台 best-effort）
port_in_use() {
  local port="$1"
  # Windows (Git Bash) netstat
  netstat -ano 2>/dev/null | grep -qE ":${port} .*LISTEN" && return 0
  # Linux ss
  ss -ltn 2>/dev/null | grep -qE ":${port} " && return 0
  # macOS / 通用 lsof
  lsof -i :"$port" 2>/dev/null | grep -q LISTEN && return 0
  return 1
}

# ---- 1. 前置检查 ----
echo ""
info "【1/4】环境检查"

[ -f package.json ] || die "未在项目根目录（找不到 package.json），请 cd 到 hermes-studio 根目录"

if ! command -v node >/dev/null 2>&1; then
  die "未找到 Node.js（需 ≥${MIN_NODE_MAJOR}.0.0）"
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
NODE_VERSION=$(node --version 2>/dev/null || echo "未知")
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  err "Node.js 版本不符：需 ≥${MIN_NODE_MAJOR}.0.0，当前 ${NODE_VERSION}"
  warn "用 nvm 切换: nvm use ${MIN_NODE_MAJOR}"
  exit 1
fi
ok "Node ${NODE_VERSION} (≥${MIN_NODE_MAJOR} ✓)"

command -v npm >/dev/null 2>&1 || die "未找到 npm"
ok "npm $(npm --version 2>/dev/null)"

# ---- 2. 依赖检查 ----
echo ""
info "【2/4】依赖检查"
if [ -d node_modules ]; then
  ok "node_modules 已存在"
else
  warn "node_modules 不存在"
  if [ "$AUTO_INSTALL" = "1" ]; then
    info "运行 npm install（首次可能需要几分钟）..."
    npm install || die "npm install 失败"
    ok "依赖安装完成"
  else
    die "node_modules 缺失且 --no-install 已指定，请手动运行: npm install"
  fi
fi

# ---- 3. 端口与 LLM 链路检查 ----
echo ""
info "【3/4】端口与 LLM 链路检查"

if port_in_use "$FRONTEND_PORT"; then
  die "前端端口 ${FRONTEND_PORT} 已被占用，请先释放（netstat -ano | findstr :${FRONTEND_PORT}）"
else
  ok "前端端口 ${FRONTEND_PORT} 空闲"
fi

if port_in_use "$BACKEND_PORT"; then
  warn "后端端口 ${BACKEND_PORT} 已被占用（dev:server 的 nodemon 可能改用其他端口或启动失败）"
else
  ok "后端端口 ${BACKEND_PORT} 空闲"
fi

if port_in_use "$CCSWITCH_PORT"; then
  ok "cc-switch 代理在跑（端口 ${CCSWITCH_PORT}），LLM 链路就绪"
else
  warn "cc-switch 代理未运行（端口 ${CCSWITCH_PORT}），LLM 调用会 401"
  warn "  排查见 docs/项目启动指南.md 第 5、7.2 节"
fi

# hermes-agent 路径检查（非阻塞）
HERMES_AGENT_DIR="${LOCALAPPDATA:-$HOME/.local/share}/hermes/hermes-agent"
if [ -d "$HERMES_AGENT_DIR" ]; then
  ok "hermes-agent 已安装: $HERMES_AGENT_DIR"
else
  warn "未找到 hermes-agent（$HERMES_AGENT_DIR），agent-bridge 可能无法启动"
fi

# ---- --check 模式 ----
if [ "$CHECK_ONLY" = "1" ]; then
  echo ""
  info "--check 模式，环境检查完成，不启动"
  exit 0
fi

# ---- 4. 启动 ----
echo ""
info "【4/4】启动开发模式"
echo ""
printf "${C_OK}══════════════════════════════════════════${C_OFF}\n"
printf "${C_OK}  Hermes Studio 开发环境${C_OFF}\n"
printf "${C_OK}  前端:   http://localhost:${FRONTEND_PORT}${C_OFF}\n"
printf "${C_OK}  后端:   http://localhost:${BACKEND_PORT}${C_OFF}\n"
printf "${C_OK}  登录:   admin / 123456${C_OFF}\n"
printf "${C_OK}  停止:   Ctrl+C${C_OFF}\n"
printf "${C_OK}══════════════════════════════════════════${C_OFF}\n"
echo ""
info "执行: npm run dev（前后端同时拉起，nodemon 守护后端热重载）"
echo ""

exec npm run dev
