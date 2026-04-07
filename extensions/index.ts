import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MARKETPLACES_DIR = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "build", "dist", "out"]);

type InstalledPluginEntry = {
  scope?: string;
  projectPath?: string;
};

type InstalledPluginsFile = {
  plugins?: Record<string, InstalledPluginEntry[]>;
};

type ClaudeSettingsFile = {
  enabledPlugins?: Record<string, boolean>;
};

function shouldIgnoreEntry(name: string, isDirectory: boolean): boolean {
  if (name.startsWith(".")) return true;
  if (isDirectory && IGNORED_DIRECTORY_NAMES.has(name)) return true;
  return false;
}

async function readEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function readDirectories(dir: string): Promise<string[]> {
  const entries = await readEntries(dir);

  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !shouldIgnoreEntry(entry.name, true))
    .map((entry) => path.join(dir, entry.name));
}

async function readMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readEntries(dir);

  return entries
    .filter((entry) => entry.isFile() && !shouldIgnoreEntry(entry.name, false) && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isSameOrDescendant(parent: string, target: string): boolean {
  return target === parent || target.startsWith(`${parent}/`);
}

async function loadPluginEnabledStates(): Promise<Record<string, boolean>> {
  let raw: string;
  try {
    raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }

  const parsed = JSON.parse(raw) as ClaudeSettingsFile;
  return parsed.enabledPlugins ?? {};
}

async function loadEnabledPluginKeys(cwd: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(INSTALLED_PLUGINS_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Set();
    throw error;
  }

  const parsed = JSON.parse(raw) as InstalledPluginsFile;
  const plugins = parsed.plugins ?? {};
  const pluginEnabledStates = await loadPluginEnabledStates();
  const normalizedCwd = normalizePath(cwd);
  const enabled = new Set<string>();

  for (const [pluginKey, entries] of Object.entries(plugins)) {
    if (pluginEnabledStates[pluginKey] === false) {
      continue;
    }

    if (!Array.isArray(entries)) continue;

    const isEnabledForCwd = entries.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.scope === "user") return true;
      if (entry.scope === "project" && typeof entry.projectPath === "string") {
        return isSameOrDescendant(normalizePath(entry.projectPath), normalizedCwd);
      }
      return true;
    });

    if (isEnabledForCwd) {
      enabled.add(pluginKey);
    }
  }

  return enabled;
}

type DiscoveredResources = {
  skillPaths: string[];
  promptPaths: string[];
};

async function findResources(cwd: string): Promise<DiscoveredResources> {
  const enabledPluginKeys = await loadEnabledPluginKeys(cwd);
  const marketplaceDirs = await readDirectories(MARKETPLACES_DIR);
  const skillPaths: string[] = [];
  const promptPaths: string[] = [];

  for (const marketplaceDir of marketplaceDirs) {
    const marketplaceName = path.basename(marketplaceDir);
    const marketplacePluginKey = `${marketplaceName}@${marketplaceName}`;

    const topLevelSkillDirs = await readDirectories(path.join(marketplaceDir, "skills"));
    for (const skillDir of topLevelSkillDirs) {
      const pluginKey = `${path.basename(skillDir)}@${marketplaceName}`;
      if (!enabledPluginKeys.has(pluginKey)) {
        continue;
      }

      const skillPath = path.join(skillDir, "SKILL.md");
      if (await fileExists(skillPath)) {
        skillPaths.push(skillPath);
      }
    }

    if (enabledPluginKeys.has(marketplacePluginKey)) {
      promptPaths.push(...(await readMarkdownFiles(path.join(marketplaceDir, "commands"))));
    }

    const pluginDirs = await readDirectories(path.join(marketplaceDir, "plugins"));
    for (const pluginDir of pluginDirs) {
      const pluginKey = `${path.basename(pluginDir)}@${marketplaceName}`;
      if (!enabledPluginKeys.has(pluginKey)) {
        continue;
      }

      const pluginSkillDirs = await readDirectories(path.join(pluginDir, "skills"));
      for (const skillDir of pluginSkillDirs) {
        const skillPath = path.join(skillDir, "SKILL.md");
        if (await fileExists(skillPath)) {
          skillPaths.push(skillPath);
        }
      }

      promptPaths.push(...(await readMarkdownFiles(path.join(pluginDir, "commands"))));
    }
  }

  return { skillPaths, promptPaths };
}

export default function claudeMarketplaceSkills(pi: ExtensionAPI) {
  async function discoverResources(cwd: string): Promise<DiscoveredResources> {
    const resources = await findResources(cwd);
    return {
      skillPaths: resources.skillPaths.sort((a, b) => a.localeCompare(b)),
      promptPaths: resources.promptPaths.sort((a, b) => a.localeCompare(b)),
    };
  }

  pi.on("resources_discover", async (event) => {
    const resources = await discoverResources(event.cwd);
    return resources;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const resources = await discoverResources(ctx.cwd);
      const skillCount = resources.skillPaths.length;
      const promptCount = resources.promptPaths.length;
      const message =
        skillCount > 0 || promptCount > 0
          ? `[claude-marketplace-skills] Loaded ${skillCount} skill file${skillCount === 1 ? "" : "s"} and ${promptCount} command file${promptCount === 1 ? "" : "s"} from ${MARKETPLACES_DIR}`
          : `[claude-marketplace-skills] No enabled skill or command files found under ${MARKETPLACES_DIR}`;

      console.log(`${message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(message, skillCount > 0 || promptCount > 0 ? "success" : "warning");
      }
    } catch (error) {
      const message = `[claude-marketplace-skills] Failed to discover resources: ${(error as Error).message}`;
      console.log(`${message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }
    }
  });
}
