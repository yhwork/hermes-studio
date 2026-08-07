import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { unzipEntries } from "./zip.js";

/**
 * 需求文档读取 —— 支持 .txt/.md/.json/.docx/.xlsx。
 * 蒸馏自 aibox 的 caseGenerateDocumentService + requirementTools.read_requirement_document。
 *
 * .docx：解 zip → word/document.xml → 提取 <w:p> 段落里的 <w:t> 文本。
 * .xlsx：解 zip → xl/sharedStrings.xml + xl/worksheets/sheetN.xml → 按 sheet/row 拼成文本。
 * .xls（旧二进制格式）：不支持，提示另存为 .xlsx。
 */

export interface ExtractedDocument {
  filePath: string;
  fileType: string;
  textContent: string;
  paragraphCount: number;
  truncated: boolean;
}

const MAX_CHARS_DEFAULT = 30000;

export function isSupportedDoc(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return [".txt", ".md", ".markdown", ".json", ".docx", ".xlsx"].includes(ext);
}

export function extractDocument(
  filePath: string,
  maxChars: number = MAX_CHARS_DEFAULT,
): ExtractedDocument {
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const ext = extname(filePath).toLowerCase();
  const buf = readFileSync(filePath);

  let textContent = "";
  let fileType = ext.slice(1);

  if (ext === ".txt" || ext === ".md" || ext === ".markdown" || ext === ".json") {
    textContent = buf.toString("utf8");
  } else if (ext === ".docx") {
    textContent = extractDocx(buf);
  } else if (ext === ".xlsx") {
    textContent = extractXlsx(buf);
  } else if (ext === ".xls") {
    throw new Error("旧版 .xls 二进制格式不支持，请另存为 .xlsx 后再读取");
  } else {
    throw new Error(`不支持的文件类型: ${ext}（支持 .txt/.md/.json/.docx/.xlsx）`);
  }

  const paragraphs = textContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const truncated = textContent.length > maxChars;
  if (truncated) {
    textContent = `${textContent.slice(0, maxChars)}\n\n...[需求文档已截断，共 ${textContent.length} 字符]`;
  }

  return {
    filePath,
    fileType,
    textContent,
    paragraphCount: paragraphs.length,
    truncated,
  };
}

// ── DOCX ──────────────────────────────────────────────────────────────

function extractDocx(buf: Buffer): string {
  const entries = unzipEntries(buf);
  const docXml = entries.get("word/document.xml");
  if (!docXml) throw new Error("损坏的 .docx：找不到 word/document.xml");
  const xml = docXml.toString("utf8");

  // 按 <w:p> 切段落，段落内拼接所有 <w:t> 内容
  const paragraphs: string[] = [];
  const pSplit = xml.split(/<\/w:p>/);
  for (const p of pSplit) {
    const texts: string[] = [];
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      texts.push(decodeXml(m[1]));
    }
    const line = texts.join("").trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join("\n");
}

// ── XLSX ──────────────────────────────────────────────────────────────

function extractXlsx(buf: Buffer): string {
  const entries = unzipEntries(buf);
  const workbookXml = entries.get("xl/workbook.xml");
  if (!workbookXml) throw new Error("损坏的 .xlsx：找不到 xl/workbook.xml");
  const wb = workbookXml.toString("utf8");

  // 工作表名顺序
  const sheetNames: string[] = [];
  const sheetRe = /<sheet[^>]*name="([^"]*)"[^>]*sheetId="[^"]*"[^>]*(?:r:id="([^"]*)")?[^>]*\/>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(wb)) !== null) {
    sheetNames.push(decodeXml(sm[1]));
  }
  // 兜底：按 sheetN.xml 顺序
  const sheetFiles = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)\.xml/)?.[1] || "0", 10);
      const nb = parseInt(b.match(/sheet(\d+)\.xml/)?.[1] || "0", 10);
      return na - nb;
    });

  // sharedStrings
  const sharedStrings: string[] = [];
  const ssXml = entries.get("xl/sharedStrings.xml");
  if (ssXml) {
    const ss = ssXml.toString("utf8");
    const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let si: RegExpExecArray | null;
    while ((si = siRe.exec(ss)) !== null) {
      const t: string[] = [];
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(si[1])) !== null) t.push(decodeXml(tm[1]));
      sharedStrings.push(t.join(""));
    }
  }

  const lines: string[] = [];
  sheetFiles.forEach((file, idx) => {
    const name = sheetNames[idx] || `Sheet${idx + 1}`;
    lines.push(`Sheet: ${name}`);
    const xml = entries.get(file)!.toString("utf8");
    const rows = xml.split(/<\/row>/);
    for (const row of rows) {
      const cells: string[] = [];
      const cRe = /<c[^>]*?(?:\s+t="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(row)) !== null) {
        const type = cm[1];
        const inner = cm[2];
        const vMatch = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        const isMatch = inner.match(/<is[^>]*>([\s\S]*?)<\/is>/);
        let value = "";
        if (type === "s" && vMatch) {
          const idx2 = parseInt(vMatch[1], 10);
          value = sharedStrings[idx2] ?? "";
        } else if (type === "inlineStr" && isMatch) {
          const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
          let tm: RegExpExecArray | null;
          const parts: string[] = [];
          while ((tm = tRe.exec(isMatch[1])) !== null) parts.push(decodeXml(tm[1]));
          value = parts.join("");
        } else if (vMatch) {
          value = vMatch[1];
        }
        if (value.trim()) cells.push(value.trim());
      }
      if (cells.length) lines.push(cells.join(" | "));
    }
    lines.push("");
  });

  return lines.join("\n").trim();
}

// ── XML decode ────────────────────────────────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
