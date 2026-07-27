#!/usr/bin/env bash
# sync-upstream.sh — 同步上游 hermes-studio 新功能到 custom 定制分支
#
# 工作流（对应 docs/定制开发工作流.md 第 4 节）：
#   1. main 拉取上游新功能（git pull --ff-only origin main）
#   2. custom 变基到最新 main 之上（git rebase main）
#   3. 推送 custom 到 fork 备份（git push -f myfork custom）
#
# rerere 已开启时，docs/openapi.json 等已知冲突会自动取上游版本解决并续跑；
# 遇到源码冲突会停下，给出手动解决指引。
#
# 用法：
#   bash scripts/sync-upstream.sh            # 完整同步并推送备份
#   bash scripts/sync-upstream.sh --no-push  # 同步但不推送到 fork
#   bash scripts/sync-upstream.sh --check    # 仅检查状态，不执行任何改动
#   bash scripts/sync-upstream.sh --help     # 查看帮助

set -uo pipefail

# ---- 配置 ----
ORIGIN_REMOTE="origin"     # 上游 EKKOLearnAI/hermes-studio
FORK_REMOTE="myfork"       # 你的 fork yhwork/hermes-studio
UPSTREAM_BRANCH="main"     # 上游镜像分支
CUSTOM_BRANCH="custom"     # 定制分支

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
DO_PUSH=1
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-push) DO_PUSH=0 ;;
    --check)   CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "未知参数: $arg (用 --help 查看用法)" ;;
  esac
done

# ---- 前置检查 ----
command -v git >/dev/null 2>&1 || die "未找到 git"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前不在 git 仓库内"

git remote get-url "$ORIGIN_REMOTE" >/dev/null 2>&1 \
  || die "未配置 remote: $ORIGIN_REMOTE（应为上游 EKKOLearnAI/hermes-studio）"
git remote get-url "$FORK_REMOTE" >/dev/null 2>&1 \
  || die "未配置 remote: $FORK_REMOTE（应为你 fork 的 yhwork/hermes-studio）"

if [ "$(git config --get rerere.enabled)" != "true" ]; then
  warn "rerere 未开启，已知冲突不会自动解决。建议: git config rerere.enabled true"
fi

if [ -n "$(git status --porcelain)" ]; then
  err "工作区不干净，请先提交或 stash 改动:"
  git status --short
  exit 1
fi

if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
  die "有 rebase 进行中，请先完成或放弃: git rebase --abort"
fi

# ---- 拉取上游信息 ----
info "拉取上游最新信息..."
git fetch "$ORIGIN_REMOTE" || die "fetch 失败"

# ---- 状态检查 ----
MAIN_BEHIND=$(git rev-list --count "$UPSTREAM_BRANCH..$ORIGIN_REMOTE/$UPSTREAM_BRANCH" 2>/dev/null || echo "?")
CUSTOM_BEHIND_MAIN=$(git rev-list --count "$CUSTOM_BRANCH..$UPSTREAM_BRANCH" 2>/dev/null || echo "?")

echo ""
info "当前状态:"
echo "  本地 $UPSTREAM_BRANCH 落后 $ORIGIN_REMOTE/$UPSTREAM_BRANCH: $MAIN_BEHIND 个提交"
echo "  $CUSTOM_BRANCH 落后本地 $UPSTREAM_BRANCH: $CUSTOM_BEHIND_MAIN 个提交"

if [ "$CHECK_ONLY" = "1" ]; then
  echo ""
  info "--check 模式，仅检查不执行"
  if [ "$MAIN_BEHIND" = "0" ] && [ "$CUSTOM_BEHIND_MAIN" = "0" ]; then
    ok "已是最新，无需同步"
  else
    warn "有待同步的提交，运行 bash scripts/sync-upstream.sh 执行同步"
  fi
  exit 0
fi

if [ "$MAIN_BEHIND" = "0" ] && [ "$CUSTOM_BEHIND_MAIN" = "0" ]; then
  ok "已是最新，无需同步"
  exit 0
fi

# ---- 步骤 1: 更新 main ----
echo ""
info "步骤 1/3: 更新 $UPSTREAM_BRANCH（快进拉取上游）"
git checkout "$UPSTREAM_BRANCH" || die "切换到 $UPSTREAM_BRANCH 失败"
git pull --ff-only "$ORIGIN_REMOTE" "$UPSTREAM_BRANCH" \
  || die "pull --ff-only 失败（上游可能已分叉，需手动处理）"
ok "$UPSTREAM_BRANCH 已快进到 $(git rev-parse --short HEAD)"

# ---- 步骤 2: rebase custom ----
echo ""
info "步骤 2/3: $CUSTOM_BRANCH 变基到 $UPSTREAM_BRANCH 之上"
git checkout "$CUSTOM_BRANCH" || die "切换到 $CUSTOM_BRANCH 失败"

# 执行 rebase：rerere 自动解决的冲突会续跑，真冲突则停下提示
do_rebase() {
  if git rebase "$UPSTREAM_BRANCH"; then
    return 0  # 干净完成
  fi
  # rebase 暂停，循环处理 rerere 已解决的冲突
  while true; do
    local unmerged
    unmerged=$(git diff --name-only --diff-filter=U)
    if [ -n "$unmerged" ]; then
      echo ""
      err "存在需要手动解决的冲突:"
      echo "$unmerged" | sed 's/^/    /'
      echo ""
      warn "解决步骤:"
      echo "    1. 编辑上述文件保留你的定制逻辑"
      echo "    2. git add <文件>"
      echo "    3. git rebase --continue    # 继续变基"
      echo "    4. 重新运行本脚本完成推送（或 git push -f $FORK_REMOTE $CUSTOM_BRANCH）"
      echo ""
      echo "    放弃: git rebase --abort"
      return 1
    fi
    info "rerere 已自动解决冲突，继续变基..."
    if GIT_EDITOR=true git rebase --continue 2>/dev/null; then
      return 0  # 完成
    fi
    # --continue 后仍有冲突，循环再检查
  done
}

if ! do_rebase; then
  exit 1
fi
ok "$CUSTOM_BRANCH 已变基到 $UPSTREAM_BRANCH 之上"

# ---- 步骤 3: 推送到 fork ----
if [ "$DO_PUSH" = "1" ]; then
  echo ""
  info "步骤 3/3: 推送 $CUSTOM_BRANCH 到 $FORK_REMOTE（备份）"
  git push -f "$FORK_REMOTE" "$CUSTOM_BRANCH" || die "推送失败"
  ok "已备份到 $FORK_REMOTE"
else
  warn "跳过推送（--no-push）；稍后可手动: git push -f $FORK_REMOTE $CUSTOM_BRANCH"
fi

# ---- 完成 ----
echo ""
ok "同步完成！当前在 $CUSTOM_BRANCH 分支"
info "定制领先 $UPSTREAM_BRANCH: $(git rev-list --count $UPSTREAM_BRANCH..$CUSTOM_BRANCH) 个提交"
