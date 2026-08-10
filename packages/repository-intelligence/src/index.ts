import { RuntimeBrokerClient } from '@oliveira/runtime-broker-client';

const broker = new RuntimeBrokerClient();
const MAX_FILES = 400;
const MAX_TEXT = 24_000;
const MAX_TREE_CHILDREN = 120;

export type RepositoryTreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  kind?: 'source' | 'test' | 'route' | 'manifest' | 'config' | 'infra' | 'other';
  children?: RepositoryTreeNode[];
};

export type RepositoryRevision = {
  branch?: string;
  head?: string;
  changedFiles: string[];
  clean: boolean;
};

export type RepositoryIntelligence = {
  generatedAt: string;
  root: string;
  files: string[];
  tree: RepositoryTreeNode[];
  topLevelDirectories: string[];
  manifests: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  architectureHints: string[];
  testFiles: number;
  routeFiles: number;
  sourceFiles: number;
  git: RepositoryRevision & { recentCommits: string[] };
  warnings: string[];
};

async function exec(containerId: string, cmd: string[], workingDir = '/workspace/repository', timeoutMs = 30_000) {
  const result = await broker.exec(containerId, { cmd, workingDir, user: 'devcloud', timeoutMs });
  return { exitCode: result.exitCode, output: result.output.slice(0, MAX_TEXT) };
}

function lines(value: string) { return value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
function isSource(f: string) { return /\.(tsx?|jsx?|py|java|cs|go|rs|rb|php)$/.test(f); }
function isTest(f: string) { return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(f); }
function isRoute(f: string) { return /(^|\/)(routes?|controllers?|api)(\/|$)|\/app\/api\//.test(f); }
function isManifest(f: string) { return /(^|\/)(package\.json|pnpm-workspace\.yaml|turbo\.json|nx\.json|pom\.xml|build\.gradle(?:\.kts)?|pyproject\.toml|requirements\.txt|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|schema\.prisma)$/.test(f); }
function classifyFile(path: string): RepositoryTreeNode['kind'] {
  if (isTest(path)) return 'test';
  if (isRoute(path)) return 'route';
  if (isManifest(path)) return 'manifest';
  if (/(^|\/)(infra|docker|\.github\/workflows)(\/|$)/.test(path) || /Dockerfile|compose\.ya?ml$/.test(path)) return 'infra';
  if (/(^|\/)(config|configs)(\/|$)|\.(config|rc)\.[^.]+$|(^|\/)tsconfig.*\.json$/.test(path)) return 'config';
  if (isSource(path)) return 'source';
  return 'other';
}

function buildTree(files: string[]): RepositoryTreeNode[] {
  type MutableNode = RepositoryTreeNode & { children?: MutableNode[] };
  const root: MutableNode[] = [];
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    let current = root;
    let accumulated = '';
    parts.forEach((part, index) => {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const isFile = index === parts.length - 1;
      let node = current.find(item => item.name === part && item.type === (isFile ? 'file' : 'directory'));
      if (!node) {
        node = { name: part, path: accumulated, type: isFile ? 'file' : 'directory', ...(isFile ? { kind: classifyFile(accumulated) } : { children: [] }) };
        if (current.length < MAX_TREE_CHILDREN) current.push(node);
      }
      if (!isFile) current = node.children ?? (node.children = []);
    });
  }
  const sortNodes = (nodes: MutableNode[]): MutableNode[] => nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  }).map(node => ({ ...node, children: node.children ? sortNodes(node.children) : undefined }));
  return sortNodes(root);
}

export async function getRepositoryRevision(containerId: string, workingDir = '/workspace/repository'): Promise<RepositoryRevision> {
  const [status, branch, head] = await Promise.all([
    exec(containerId, ['git', 'status', '--porcelain=v1'], workingDir),
    exec(containerId, ['git', 'branch', '--show-current'], workingDir),
    exec(containerId, ['git', 'rev-parse', 'HEAD'], workingDir)
  ]);
  const changedFiles = status.exitCode === 0 ? lines(status.output).map(v => v.slice(3)).slice(0, 100) : [];
  return {
    branch: branch.exitCode === 0 ? lines(branch.output)[0] : undefined,
    head: head.exitCode === 0 ? lines(head.output)[0] : undefined,
    changedFiles,
    clean: status.exitCode === 0 && changedFiles.length === 0
  };
}

export async function inspectRepository(containerId: string, knownRevision?: RepositoryRevision, workingDir = '/workspace/repository'): Promise<RepositoryIntelligence> {
  const warnings: string[] = [];
  const find = await exec(containerId, ['find', '.', '-type', 'f', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*', '-not', '-path', './dist/*', '-not', '-path', './build/*', '-not', '-path', './.next/*', '-not', '-path', './coverage/*', '-not', '-name', '.env', '-not', '-name', '.env.*'], workingDir);
  if (find.exitCode !== 0) warnings.push('FILE_MAP_UNAVAILABLE');
  const allFiles = lines(find.output).map(f => f.startsWith('./') ? f.slice(2) : f).sort();
  const files = allFiles.slice(0, MAX_FILES);
  if (allFiles.length > MAX_FILES) warnings.push(`FILE_MAP_TRUNCATED:${allFiles.length}`);
  const topLevelDirectories = Array.from(new Set(files.filter(f => f.includes('/')).map(f => f.split('/')[0]))).slice(0, 80);
  const manifestNames = ['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'requirements.txt', 'Dockerfile', 'docker-compose.yml', 'compose.yml', 'prisma/schema.prisma'];
  const manifests = manifestNames.filter(m => files.includes(m) || files.some(f => f.endsWith('/' + m)));
  let scripts: Record<string, string> = {}, dependencies: string[] = [], devDependencies: string[] = [];
  if (files.includes('package.json')) {
    const pkg = await exec(containerId, ['cat', 'package.json'], workingDir);
    try {
      const parsed = JSON.parse(pkg.output);
      scripts = parsed.scripts ?? {};
      dependencies = Object.keys(parsed.dependencies ?? {}).sort().slice(0, 120);
      devDependencies = Object.keys(parsed.devDependencies ?? {}).sort().slice(0, 120);
    } catch { warnings.push('PACKAGE_JSON_PARSE_FAILED'); }
  }
  const hints: string[] = [];
  const joined = '\n' + files.join('\n');
  const patterns: [RegExp, string][] = [
    [/\napps\//, 'monorepo: apps/'], [/\npackages\//, 'monorepo: packages/'], [/\n(src\/)?routes?\//, 'routes layer'], [/\n(src\/)?controllers?\//, 'controllers layer'], [/\n(src\/)?services?\//, 'services layer'], [/\n(src\/)?repositories?\//, 'repository/data-access layer'], [/\nprisma\//, 'Prisma ORM'], [/\nmigrations?\//, 'database migrations'], [/\n\.github\/workflows\//, 'GitHub Actions CI/CD'], [/\ninfra\//, 'infrastructure-as-code directory'], [/\ndocker-compose\.ya?ml/, 'Docker Compose'], [/\nDockerfile/, 'Docker image definition']
  ];
  for (const [re, label] of patterns) if (re.test(joined)) hints.push(label);
  const revision = knownRevision ?? await getRepositoryRevision(containerId, workingDir);
  const log = await exec(containerId, ['git', 'log', '-5', '--pretty=format:%h %s'], workingDir);
  if (!revision.head) warnings.push('GIT_HEAD_UNAVAILABLE');
  return {
    generatedAt: new Date().toISOString(), root: workingDir, files, tree: buildTree(files), topLevelDirectories, manifests, scripts, dependencies, devDependencies,
    architectureHints: hints, testFiles: files.filter(isTest).length, routeFiles: files.filter(isRoute).length, sourceFiles: files.filter(isSource).length,
    git: { ...revision, recentCommits: log.exitCode === 0 ? lines(log.output) : [] }, warnings
  };
}
