import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

/**
 * Skill 加载器 —— 读取 SKILL.md 文件，解析 YAML frontmatter + 正文。
 *
 * 支持两种来源：
 *   1. 独立 skill 目录（子 agent 自己的，在 demo 目录下的 `skills/`）
 *   2. 主 agent 的 skill 目录（继承：hermes-home/skills/ 或 profiles/<name>/skills/）
 *
 * 配置优先级（MCP env 控制）：
 *   - AGENT_SKILLS_DIR：子 agent 独立 skill 目录（可多个，逗号分隔）
 *   - AGENT_SKILLS：按名称选择要加载的 skill（逗号分隔），不设则全部加载
 *   - AGENT_SKILLS_INHERIT=true（默认）：是否继承主 agent 的 skill
 *
 * 最终合并：独立 skill（优先）+ 继承 skill（如果开启且名称不冲突）。
 */

export interface LoadedSkill {
  id: string;
  name: string;
  description?: string;
  instructions: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  [key: string]: unknown;
}

/** 解析 SKILL.md：YAML frontmatter（`---` 包裹） + 正文作为 instructions。 */
function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  let frontmatter: SkillFrontmatter = {};
  try {
    frontmatter = parseYaml(match[1]) || {};
  } catch { /* malformed yaml, skip */ }
  return { frontmatter, body: match[2].trim() };
}

/** 从目录加载单个 skill（找 SKILL.md）。 */
function loadSkillFromDir(dir: string): LoadedSkill | null {
  const skillFile = join(dir, "SKILL.md");
  if (!existsSync(skillFile)) return null;
  try {
    const raw = readFileSync(skillFile, "utf8");
    const { frontmatter, body } = parseSkillMd(raw);
    if (!body) return null;
    const name = frontmatter.name || basename(dir);
    return {
      id: name,
      name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
      instructions: body,
    };
  } catch {
    return null;
  }
}

/** 扫描一个目录下的所有子目录，每个子目录加载一个 skill。支持嵌套一层。 */
function scanSkillDir(baseDir: string): LoadedSkill[] {
  if (!existsSync(baseDir)) return [];
  const skills: LoadedSkill[] = [];
  try {
    for (const entry of readdirSync(baseDir)) {
      const entryPath = join(baseDir, entry);
      if (!statSync(entryPath).isDirectory()) continue;
      // 直接子目录有 SKILL.md
      const direct = loadSkillFromDir(entryPath);
      if (direct) { skills.push(direct); continue; }
      // 嵌套一层（如 apple/apple-notes/SKILL.md）
      for (const sub of readdirSync(entryPath)) {
        const subPath = join(entryPath, sub);
        if (statSync(subPath).isDirectory()) {
          const nested = loadSkillFromDir(subPath);
          if (nested) skills.push(nested);
        }
      }
    }
  } catch { /* dir read error, skip */ }
  return skills;
}

/** hermes-home skill 目录路径。 */
function hermesSkillDir(): string {
  const home = process.env.HERMES_HOME || join(homedir(), "AppData", "Local", "hermes");
  const profile = process.env.HERMES_PROFILE || "default";
  if (profile && profile !== "default") {
    return join(home, "profiles", profile, "skills");
  }
  return join(home, "skills");
}

/**
 * 加载子 agent 可用的 skills。
 *
 * 合并策略：
 *   1. 独立 skill（AGENT_SKILLS_DIR，或 demo 目录下的 `skills/`）—— 优先
 *   2. 继承主 agent skill（AGENT_SKILLS_INHERIT≠false 时）—— 名称不冲突才加入
 *   3. AGENT_SKILLS 过滤：如果设了，只保留指定名称的 skill
 */
export function loadSkills(demoDirname: string): LoadedSkill[] {
  const allSkills = new Map<string, LoadedSkill>();

  // 1. 独立 skill 目录
  const customDirs = (process.env.AGENT_SKILLS_DIR ?? "").split(",").map(s => s.trim()).filter(Boolean);
  // 默认也扫 demo 目录下的 skills/
  const defaultLocalDir = join(demoDirname, "..", "skills");
  const localDirs = customDirs.length ? customDirs : [defaultLocalDir];
  for (const dir of localDirs) {
    for (const skill of scanSkillDir(dir)) {
      allSkills.set(skill.name, skill);
    }
  }

  // 2. 继承主 agent skill
  const inherit = (process.env.AGENT_SKILLS_INHERIT ?? "true").toLowerCase() !== "false";
  if (inherit) {
    const hermesDir = hermesSkillDir();
    for (const skill of scanSkillDir(hermesDir)) {
      if (!allSkills.has(skill.name)) { // 独立 skill 优先，不覆盖
        allSkills.set(skill.name, skill);
      }
    }
  }

  // 3. AGENT_SKILLS 过滤
  const filterNames = (process.env.AGENT_SKILLS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (filterNames.length) {
    const filtered = new Map<string, LoadedSkill>();
    for (const name of filterNames) {
      const skill = allSkills.get(name);
      if (skill) filtered.set(name, skill);
    }
    return [...filtered.values()];
  }

  return [...allSkills.values()];
}
