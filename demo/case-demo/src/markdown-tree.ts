import { createHash } from "node:crypto";
import { zipFiles } from "./zip.js";

/**
 * 用例 Markdown 树 —— 解析、校验、序列化、导出 .xmind。
 * 蒸馏自 aibox 的 markdownToXmind.ts + caseValidator。
 *
 * 树结构：{ title, level, children }
 * Markdown 语法：# 标题（1~6 级）+ - 列表项（缩进表达层级）。
 */

export interface MarkdownNode {
  title: string;
  level: number;
  children: MarkdownNode[];
}

const HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*$/;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;

// ── 解析 ──────────────────────────────────────────────────────────────

export function parseMarkdownToTree(markdown: string, titleOverride?: string): MarkdownNode {
  const root = createNode(titleOverride || "测试用例", 0);
  const stack: MarkdownNode[] = [root];
  let lastHeadingLevel: number | null = null;
  let hasNode = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ").replace(/\s+$/g, "");
    if (!line.trim()) continue;

    let level: number | null = null;
    let text: string | null = null;
    const heading = line.match(HEADING_RE);

    if (heading) {
      level = heading[1].length;
      text = cleanTitle(heading[2]);
      lastHeadingLevel = level;
    } else {
      const listItem = line.match(LIST_RE);
      if (listItem) {
        const indentLevel = Math.floor(listItem[1].length / 2);
        level = (lastHeadingLevel || 0) + indentLevel + 1;
        text = cleanTitle(listItem[2]);
      }
    }

    if (!level || !text) continue;

    hasNode = true;
    const node = createNode(text, level);
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  if (!hasNode) {
    throw new Error("Markdown 中未找到可解析的标题或列表项");
  }

  if (titleOverride) return root;
  return root.children.length === 1 ? root.children[0] : root;
}

// ── 序列化 ────────────────────────────────────────────────────────────

export function treeToMarkdown(node: MarkdownNode, level: number = 0): string {
  const lines: string[] = [];
  serializeNode(node, level, lines);
  return lines.join("\n");
}

function serializeNode(node: MarkdownNode, level: number, out: string[]): void {
  if (level === 0) {
    out.push(`# ${node.title}`);
  } else if (level <= 6) {
    out.push(`${"#".repeat(level)} ${node.title}`);
  } else {
    const indent = "  ".repeat(level - 7);
    out.push(`${indent}- ${node.title}`);
  }
  for (const child of node.children) {
    serializeNode(child, level + 1, out);
  }
}

// ── 统计 ──────────────────────────────────────────────────────────────

export interface TreeStats {
  totalNodes: number;
  maxDepth: number;
  leafCount: number;
  rootTitle: string;
  level2Domains: string[];
}

export function treeStats(root: MarkdownNode): TreeStats {
  let totalNodes = 0;
  let maxDepth = 0;
  let leafCount = 0;
  const level2Domains: string[] = [];

  function walk(node: MarkdownNode, depth: number): void {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    if (node.children.length === 0) leafCount++;
    if (depth === 2) level2Domains.push(node.title);
    for (const c of node.children) walk(c, depth + 1);
  }
  walk(root, 1);

  return {
    totalNodes,
    maxDepth,
    leafCount,
    rootTitle: root.title,
    level2Domains,
  };
}

// ── 校验 ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
  stats: TreeStats;
}

export function validateTree(root: MarkdownNode): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const stats = treeStats(root);

  if (stats.maxDepth < 3) {
    issues.push(`层级过浅（最深 ${stats.maxDepth} 层）：用例应至少有「功能域 → 场景 → 预期」三层。`);
  }
  if (stats.leafCount < 3) {
    warnings.push(`叶子节点过少（${stats.leafCount} 个）：用例树可能不够细化。`);
  }
  if (stats.level2Domains.length === 0) {
    issues.push("缺少第 2 层功能域/测试维度分类。");
  }

  // 叶子节点过长的检查
  function checkLeaves(node: MarkdownNode, depth: number): void {
    for (const c of node.children) {
      if (c.children.length === 0) {
        if (c.title.length > 40) {
          warnings.push(`叶子节点过长（${c.title.length} 字）: "${c.title.slice(0, 30)}…"`);
        }
        if (/^(操作|前置|预期)[：:]/.test(c.title)) {
          issues.push(`叶子节点不应写"操作：/前置：/预期："前缀，应拆到上层节点: "${c.title.slice(0, 20)}"`);
        }
      } else {
        checkLeaves(c, depth + 1);
      }
    }
  }
  checkLeaves(root, 1);

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    stats,
  };
}

// ── 导出 .xmind ───────────────────────────────────────────────────────

export function treeToXmindBuffer(root: MarkdownNode): Buffer {
  const content = JSON.stringify(buildContent(root), null, 2);
  const metadata = JSON.stringify(buildMetadata(), null, 2);
  const manifest = JSON.stringify(buildManifest(), null, 2);
  const thumbnail = buildThumbnail(root.title);

  return zipFiles([
    { name: "content.json", data: Buffer.from(content, "utf8") },
    { name: "metadata.json", data: Buffer.from(metadata, "utf8") },
    { name: "manifest.json", data: Buffer.from(manifest, "utf8") },
    { name: "Thumbnails/thumbnail.svg", data: Buffer.from(thumbnail, "utf8") },
  ]);
}

// ── helpers ───────────────────────────────────────────────────────────

function createNode(title: string, level: number): MarkdownNode {
  return { title, level, children: [] };
}

function cleanTitle(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/_([^_]*)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function buildContent(root: MarkdownNode) {
  const now = Date.now();
  return [
    {
      id: "sheet-1",
      class: "sheet",
      title: root.title,
      rootTopic: toXmindNode(root),
      topicPositioning: "fixed",
      extensions: [],
      theme: { map: { backgroundColor: "#FFFFFF" } },
      created: now,
      modified: now,
    },
  ];
}

function buildMetadata() {
  const now = Date.now();
  return {
    creator: { name: "case-demo", version: "1.0.0" },
    created: now,
    modified: now,
  };
}

function buildManifest() {
  return {
    "file-entries": {
      "content.json": {},
      "metadata.json": {},
      "Thumbnails/thumbnail.svg": {},
    },
  };
}

function toXmindNode(node: MarkdownNode, pathParts: string[] = []): Record<string, unknown> {
  const currentPath = [...pathParts, node.title];
  const data: Record<string, unknown> = {
    id: createNodeId(currentPath),
    title: node.title,
  };
  if (node.children.length > 0) {
    data.children = {
      attached: node.children.map((child) => toXmindNode(child, currentPath)),
    };
  }
  return data;
}

function createNodeId(pathParts: string[]): string {
  return `n-${createHash("sha1").update(pathParts.join("␟")).digest("hex").slice(0, 20)}`;
}

function buildThumbnail(title: string): string {
  const safeTitle = escapeXml(title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240">
  <rect width="400" height="240" fill="#ffffff"/>
  <rect x="24" y="88" width="352" height="64" rx="12" fill="#eef5ff" stroke="#5b8def"/>
  <text x="200" y="125" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#1f2937">${safeTitle}</text>
</svg>
`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
