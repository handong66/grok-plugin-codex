#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(".");
const root = resolve("plugins/grok-plugin-codex");
const manifestPath = join(root, ".codex-plugin", "plugin.json");
const mcpPath = join(root, ".mcp.json");
const skillPath = join(root, "skills", "grok", "SKILL.md");
const marketplacePath = join(repoRoot, ".agents", "plugins", "marketplace.json");
const distPath = join(root, "dist", "server.js");
const workerDistPath = join(root, "dist", "job-worker.js");
const packagePath = join(repoRoot, "package.json");
const serverSourcePath = join(root, "src", "server.ts");
const privacyPath = join(repoRoot, "docs", "privacy.md");
const termsPath = join(repoRoot, "docs", "terms.md");
const securityPath = join(repoRoot, "SECURITY.md");
const contributingPath = join(repoRoot, "CONTRIBUTING.md");
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
    return {};
  }
}

function requireString(object, field, source = "plugin.json") {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    errors.push(`${source} requires non-empty ${field}`);
  }
}

for (const path of [
  manifestPath,
  mcpPath,
  skillPath,
  marketplacePath,
  distPath,
  workerDistPath,
  packagePath,
  serverSourcePath,
  privacyPath,
  termsPath,
  securityPath,
  contributingPath
]) {
  if (!existsSync(path)) errors.push(`missing ${path}`);
}

const manifest = readJson(manifestPath);
const packageJson = readJson(packagePath);
for (const field of ["name", "version", "description", "skills", "mcpServers", "homepage", "repository", "license"]) {
  requireString(manifest, field);
}
if (manifest.name !== "grok-plugin-codex") errors.push("plugin name must be grok-plugin-codex");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  errors.push("plugin version must be semver");
}
const manifestBaseVersion = String(manifest.version ?? "").split("+")[0];
if (manifestBaseVersion !== packageJson.version) {
  errors.push("plugin base version must match package version");
}
if (
  manifest.version !== packageJson.version &&
  !String(manifest.version).startsWith(`${packageJson.version}+codex.`)
) {
  errors.push("plugin build metadata must be a single +codex.<cachebuster> suffix");
}
const serverSource = existsSync(serverSourcePath) ? readFileSync(serverSourcePath, "utf8") : "";
if (!serverSource.includes(`version: "${packageJson.version}"`)) {
  errors.push("MCP server version must match package base version");
}
if (manifest.skills !== "./skills/") errors.push("skills must point to ./skills/");
if (manifest.mcpServers !== "./.mcp.json") errors.push("mcpServers must point to ./.mcp.json");
if (manifest.interface?.displayName !== "Grok for Codex") errors.push("interface.displayName must be Grok for Codex");
if (manifest.interface?.developerName !== "handong66") errors.push("interface.developerName must be handong66");
if (manifest.interface?.category !== "Developer Tools") errors.push("interface.category must be Developer Tools");
if (manifest.interface?.privacyPolicyURL !== "https://github.com/handong66/grok-plugin-codex/blob/main/docs/privacy.md") {
  errors.push("interface.privacyPolicyURL must point to docs/privacy.md");
}
if (manifest.interface?.termsOfServiceURL !== "https://github.com/handong66/grok-plugin-codex/blob/main/docs/terms.md") {
  errors.push("interface.termsOfServiceURL must point to docs/terms.md");
}
if (!Array.isArray(manifest.interface?.defaultPrompt) || manifest.interface.defaultPrompt.length !== 3) {
  errors.push("interface.defaultPrompt must contain exactly 3 prompts");
}
if (JSON.stringify(manifest).includes("[TODO:")) errors.push("plugin.json must not contain TODO placeholders");

const mcp = readJson(mcpPath);
const server = mcp.mcpServers?.["grok-plugin-codex"];
if (!server) errors.push(".mcp.json must define grok-plugin-codex server");
if (server?.command !== "node") errors.push("MCP server command must be node");
if (!server?.args?.includes("./dist/server.js")) errors.push("MCP server must launch ./dist/server.js");
for (const envVar of ["GROK_BIN", "GROK_PLUGIN_STATE_DIR", "HOME", "PATH", "XDG_STATE_HOME"]) {
  if (!server?.env_vars?.includes(envVar)) errors.push(`MCP server env_vars must include ${envVar}`);
}

const marketplace = readJson(marketplacePath);
if (marketplace.name !== "grok-plugin-codex") errors.push("marketplace name must be grok-plugin-codex");
const marketplaceEntry = marketplace.plugins?.find?.((plugin) => plugin.name === "grok-plugin-codex");
if (!marketplaceEntry) errors.push("marketplace must include grok-plugin-codex entry");
if (marketplaceEntry?.source?.path !== "./plugins/grok-plugin-codex") {
  errors.push("marketplace entry source.path must be ./plugins/grok-plugin-codex");
}
if (marketplaceEntry?.policy?.installation !== "AVAILABLE") errors.push("marketplace policy.installation must be AVAILABLE");
if (marketplaceEntry?.policy?.authentication !== "ON_INSTALL") errors.push("marketplace policy.authentication must be ON_INSTALL");
if (marketplaceEntry?.category !== "Developer Tools") errors.push("marketplace category must be Developer Tools");

const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
if (!skill.startsWith("---\n")) errors.push("skill must start with YAML frontmatter");
if (!skill.includes("name: grok")) errors.push("skill frontmatter must name grok");
if (!skill.includes("GROK_BIN")) errors.push("skill must document trusted GROK_BIN configuration");
if (!skill.includes("resultComplete")) errors.push("skill must document background finality");
if (!skill.includes("$grok-codex-collaboration")) errors.push("skill must route orchestration to grok-codex-collaboration");

const dist = existsSync(distPath) ? readFileSync(distPath, "utf8") : "";
if (!dist.startsWith("#!/usr/bin/env node")) errors.push("dist/server.js must be executable Node script with shebang");
const workerDist = existsSync(workerDistPath) ? readFileSync(workerDistPath, "utf8") : "";
if (!workerDist.startsWith("#!/usr/bin/env node")) errors.push("dist/job-worker.js must be executable Node script with shebang");

if (errors.length) {
  console.error("Plugin validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Plugin validation passed: ${root}`);
