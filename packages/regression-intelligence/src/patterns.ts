// Shared, deterministic path/name heuristics. Kept in one place so every detector agrees on what
// counts as a test file, a critical module, a migration, a dependency manifest, or a deploy config —
// mirrors the conservative, regex-based style already used by @oliveira/repository-intelligence and
// @oliveira/contract-intelligence (no AST, no network calls, no LLM).

export const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^./]+$/i;

export const MIGRATION_PATH_RE = /(^|\/)(migrations?)(\/|$)|(^|\/)schema\.prisma$|\.sql$/i;

// Sensitive application-logic areas (excludes migrations/database, which get their own MIGRATION_RISK
// finding so a single file doesn't produce two overlapping findings).
export const CRITICAL_MODULE_RE = /(^|\/)(auth|security|payments?|checkout|permissions?|rbac|secrets?|workspace-engine|docker-engine|agent-engine)(?:[/.]|$)/i;

export const DEPENDENCY_MANIFEST_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle(?:\.kts)?|requirements\.txt|pyproject\.toml)$/i;

export const CONFIG_FILE_RE = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|nginx[^/]*\.conf|nginx\/.+\.conf|\.env\.example|\.github\/workflows\/.+\.ya?ml)$/i;

// Subset of CONFIG_FILE_RE that raises the default severity (deploy-breaking surface).
export const HIGH_IMPACT_CONFIG_RE = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

export function isMigrationFile(path: string): boolean {
  return MIGRATION_PATH_RE.test(path);
}

export function isCriticalModuleFile(path: string): boolean {
  return CRITICAL_MODULE_RE.test(path) && !isMigrationFile(path);
}

export function isDependencyManifest(path: string): boolean {
  return DEPENDENCY_MANIFEST_RE.test(path);
}

export function isConfigFile(path: string): boolean {
  return CONFIG_FILE_RE.test(path);
}

export function isHighImpactConfigFile(path: string): boolean {
  return HIGH_IMPACT_CONFIG_RE.test(path);
}
