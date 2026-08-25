import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const MARKETPLACES_DIR = path.join(CLAUDE_CONFIG_DIR, "plugins", "marketplaces");
const INSTALLED_PLUGINS_PATH = path.join(CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json");
const CLAUDE_USER_SETTINGS_PATH = path.join(CLAUDE_CONFIG_DIR, "settings.json");
const CLAUDE_USER_LOCAL_SETTINGS_PATH = path.join(CLAUDE_CONFIG_DIR, "settings.local.json");
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "build", "dist", "out"]);

type InstalledPluginEntry = {
  scope?: string;
  projectPath?: string;
  installPath?: string;
};

type InstalledPluginsFile = {
  plugins?: Record<string, InstalledPluginEntry[]>;
};

type ClaudeSettingsFile = {
  enabledPlugins?: Record<string, boolean>;
  skillOverrides?: Record<string, string>;
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
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && !shouldIgnoreEntry(entry.name, false) && entry.name.endsWith(".md"))
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

async function readSettingsFile(filePath: string): Promise<ClaudeSettingsFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }

  try {
    return JSON.parse(raw) as ClaudeSettingsFile;
  } catch {
    // Claude Code warns and ignores malformed settings files; match that.
    return {};
  }
}

// Merged view of the settings files Claude Code consults, lowest precedence
// first: user settings, then project settings, then local overrides. Per-key
// precedence inside each map is local > project > user, matching Claude
// Code's lookup order for skillOverrides and enabledPlugins.
type MergedClaudeSettings = {
  enabledPlugins: Record<string, boolean>;
  skillOverrides: Record<string, string>;
};

async function loadMergedClaudeSettings(cwd: string): Promise<MergedClaudeSettings> {
  const files = await Promise.all([
    readSettingsFile(CLAUDE_USER_SETTINGS_PATH),
    readSettingsFile(CLAUDE_USER_LOCAL_SETTINGS_PATH),
    readSettingsFile(path.join(cwd, ".claude", "settings.json")),
    readSettingsFile(path.join(cwd, ".claude", "settings.local.json")),
  ]);
  const [user, userLocal, project, projectLocal] = files;

  return {
    enabledPlugins: {
      ...user.enabledPlugins,
      ...project.enabledPlugins,
      ...userLocal.enabledPlugins,
      ...projectLocal.enabledPlugins,
    },
    skillOverrides: {
      ...user.skillOverrides,
      ...project.skillOverrides,
      ...userLocal.skillOverrides,
      ...projectLocal.skillOverrides,
    },
  };
}

// Pi-only layer, applied after all Claude settings are resolved. Lets a user
// diverge pi from Claude Code (e.g. keep a skill on in Claude but off in pi)
// without touching shared Claude config. Mirrors the Claude layering:
// project pi settings beat user pi settings, local beats non-local.
type PiOverridesFile = {
  skillOverrides?: Record<string, string>;
  enabledPlugins?: Record<string, boolean>;
};

async function loadMergedPiOverrides(cwd: string): Promise<PiOverridesFile> {
  const files = await Promise.all([
    readSettingsFile(path.join(os.homedir(), ".pi", "agent", "claude-overrides.json")),
    readSettingsFile(path.join(cwd, ".pi", "claude-overrides.json")),
    readSettingsFile(path.join(cwd, ".pi", "claude-overrides.local.json")),
  ]);
  const [user, project, projectLocal] = files as PiOverridesFile[];

  return {
    enabledPlugins: { ...user.enabledPlugins, ...project.enabledPlugins, ...projectLocal.enabledPlugins },
    skillOverrides: { ...user.skillOverrides, ...project.skillOverrides, ...projectLocal.skillOverrides },
  };
}

async function loadEnabledPlugins(
  cwd: string,
): Promise<{ enabledKeys: Set<string>; installPaths: Map<string, string[]> }> {
  let raw: string;
  try {
    raw = await readFile(INSTALLED_PLUGINS_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { enabledKeys: new Set(), installPaths: new Map() };
    throw error;
  }

  const parsed = JSON.parse(raw) as InstalledPluginsFile;
  const plugins = parsed.plugins ?? {};
  const claudeEnabled = (await loadMergedClaudeSettings(cwd)).enabledPlugins;
  const piOverrides = await loadMergedPiOverrides(cwd);
  const pluginEnabledStates = { ...claudeEnabled, ...piOverrides.enabledPlugins };
  const normalizedCwd = normalizePath(cwd);
  const enabledKeys = new Set<string>();
  const installPaths = new Map<string, string[]>();

  for (const [pluginKey, entries] of Object.entries(plugins)) {
    if (pluginEnabledStates[pluginKey] === false) {
      continue;
    }

    if (!Array.isArray(entries)) continue;

    const enabledEntries = entries.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.scope === "user") return true;
      if (entry.scope === "project" && typeof entry.projectPath === "string") {
        return isSameOrDescendant(normalizePath(entry.projectPath), normalizedCwd);
      }
      return true;
    });

    if (enabledEntries.length > 0) {
      enabledKeys.add(pluginKey);
      installPaths.set(
        pluginKey,
        enabledEntries
          .map((entry) => entry.installPath)
          .filter((installPath): installPath is string => typeof installPath === "string" && installPath.length > 0),
      );
    }
  }

  return { enabledKeys, installPaths };
}

function isSkillEnabled(skillOverrides: Record<string, string>, skillName: string, pluginName?: string): boolean {
  const value = skillOverrides[skillName] ?? (pluginName ? skillOverrides[`${pluginName}:${skillName}`] : undefined);
  return value !== "off";
}

type DiscoveredResources = {
  skillPaths: string[];
  promptPaths: string[];
};

async function discoverSkillsAndCommandsInPlugin(
  pluginRoot: string,
  pluginName: string,
  skillOverrides: Record<string, string>,
  skillPaths: string[],
  promptPaths: string[],
): Promise<void> {
  const skillDirs = await readDirectories(path.join(pluginRoot, "skills"));
  for (const skillDir of skillDirs) {
    if (!isSkillEnabled(skillOverrides, path.basename(skillDir), pluginName)) continue;
    const skillPath = path.join(skillDir, "SKILL.md");
    if (await fileExists(skillPath)) {
      skillPaths.push(skillPath);
    }
  }

  promptPaths.push(...(await readMarkdownFiles(path.join(pluginRoot, "commands"))));
}

async function findResources(cwd: string): Promise<DiscoveredResources> {
  const claudeOverrides = (await loadMergedClaudeSettings(cwd)).skillOverrides;
  const piOverrides = await loadMergedPiOverrides(cwd);
  // Pi-only overrides apply last, after every Claude settings layer.
  const skillOverrides = { ...claudeOverrides, ...piOverrides.skillOverrides };
  const { enabledKeys, installPaths } = await loadEnabledPlugins(cwd);
  const marketplaceDirs = await readDirectories(MARKETPLACES_DIR);
  const skillPaths: string[] = [];
  const promptPaths: string[] = [];

  for (const marketplaceDir of marketplaceDirs) {
    const marketplaceName = path.basename(marketplaceDir);
    const marketplacePluginKey = `${marketplaceName}@${marketplaceName}`;

    const topLevelSkillDirs = await readDirectories(path.join(marketplaceDir, "skills"));
    const isMarketplacePluginEnabled = enabledKeys.has(marketplacePluginKey);
    for (const skillDir of topLevelSkillDirs) {
      const skillName = path.basename(skillDir);
      const pluginKey = `${skillName}@${marketplaceName}`;
      if (!isMarketplacePluginEnabled && !enabledKeys.has(pluginKey)) {
        continue;
      }
      if (!isSkillEnabled(skillOverrides, skillName, marketplaceName)) continue;

      const skillPath = path.join(skillDir, "SKILL.md");
      if (await fileExists(skillPath)) {
        skillPaths.push(skillPath);
      }
    }

    if (isMarketplacePluginEnabled) {
      promptPaths.push(...(await readMarkdownFiles(path.join(marketplaceDir, "commands"))));
    }

    const pluginDirs = await readDirectories(path.join(marketplaceDir, "plugins"));
    for (const pluginDir of pluginDirs) {
      const pluginName = path.basename(pluginDir);
      const pluginKey = `${pluginName}@${marketplaceName}`;
      if (!enabledKeys.has(pluginKey)) {
        continue;
      }

      await discoverSkillsAndCommandsInPlugin(pluginDir, pluginName, skillOverrides, skillPaths, promptPaths);
    }
  }

  // Plugins whose installed files live outside the marketplaces dir (e.g. the
  // ~/.claude/plugins/cache layout referenced by installed_plugins.json) are
  // invisible to the marketplace glob above; scan their installPaths directly.
  // Deduplicate against marketplace-discovered files by name: the cache copy is
  // the actually-installed version and wins over a stale marketplace checkout.
  const seenSkillNames = new Set(
    skillPaths.map((skillPath) => path.basename(path.dirname(skillPath))),
  );
  const seenPromptNames = new Set(promptPaths.map((promptPath) => path.basename(promptPath)));
  for (const [pluginKey, paths] of installPaths) {
    const pluginName = pluginKey.split("@")[0];
    for (const installPath of paths) {
      const normalizedInstallPath = normalizePath(installPath);
      const coveredByMarketplaceScan = isSameOrDescendant(normalizePath(MARKETPLACES_DIR), normalizedInstallPath);
      if (coveredByMarketplaceScan) continue;

      const newSkillPaths: string[] = [];
      const newPromptPaths: string[] = [];
      await discoverSkillsAndCommandsInPlugin(normalizedInstallPath, pluginName, skillOverrides, newSkillPaths, newPromptPaths);
      for (const skillPath of newSkillPaths) {
        const skillName = path.basename(path.dirname(skillPath));
        if (seenSkillNames.has(skillName)) continue;
        seenSkillNames.add(skillName);
        skillPaths.push(skillPath);
      }
      for (const promptPath of newPromptPaths) {
        const promptName = path.basename(promptPath);
        if (seenPromptNames.has(promptName)) continue;
        seenPromptNames.add(promptName);
        promptPaths.push(promptPath);
      }
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
        ctx.ui.notify(message, skillCount > 0 || promptCount > 0 ? "info" : "warning");
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
