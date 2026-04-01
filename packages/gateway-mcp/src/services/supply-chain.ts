/**
 * Supply Chain Security — source map leak detection, pre-publish scanning,
 * secret detection in build artifacts.
 *
 * Scans npm/Python/Docker packages for:
 *   - .map files (source maps containing full source code)
 *   - Secrets/credentials in published files
 *   - .env files and config with auth tokens
 *   - Embedded sourceMappingURL references
 *   - System prompts and internal constants in sourcesContent
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, relative } from 'path';

export interface ScanResult {
  safe: boolean;
  issues: ScanIssue[];
  files_scanned: number;
  source_maps_found: string[];
  secrets_found: string[];
}

export interface ScanIssue {
  type: 'source_map' | 'secret' | 'env_file' | 'source_mapping_url' | 'npmrc_token' | 'sourcesContent';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  file: string;
  detail: string;
}

// Files that should never be published
const DANGEROUS_FILES = [
  '.env', '.env.local', '.env.production', '.env.development',
  '.npmrc', '.pypirc', '.docker/config.json',
  'id_rsa', 'id_ed25519', 'id_dsa',
  '.aws/credentials', '.gcloud/credentials.json',
];

// Secret patterns to scan for
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; severity: ScanIssue['severity'] }> = [
  { name: 'AWS Access Key',     pattern: /AKIA[0-9A-Z]{16}/,                         severity: 'CRITICAL' },
  { name: 'AWS Secret Key',     pattern: /[A-Za-z0-9/+=]{40}(?=\s|"|'|$)/,           severity: 'CRITICAL' },
  { name: 'GitHub Token',       pattern: /gh[ps]_[A-Za-z0-9_]{36,}/,                 severity: 'CRITICAL' },
  { name: 'npm Token',          pattern: /npm_[A-Za-z0-9]{36,}/,                     severity: 'CRITICAL' },
  { name: 'Private Key',        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, severity: 'CRITICAL' },
  { name: 'Generic API Key',    pattern: /(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token)\s*[=:]\s*['"][A-Za-z0-9_\-/.]{20,}['"]/i, severity: 'HIGH' },
  { name: 'Database URL',       pattern: /(?:postgres|mysql|mongodb|redis|mssql):\/\/[^\s"']+/i, severity: 'HIGH' },
  { name: 'JWT Token',          pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: 'HIGH' },
  { name: 'Slack Webhook',      pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/, severity: 'HIGH' },
  { name: 'Anthropic Key',      pattern: /sk-ant-[A-Za-z0-9_-]{40,}/,                severity: 'CRITICAL' },
  { name: 'OpenAI Key',         pattern: /sk-[A-Za-z0-9]{48,}/,                      severity: 'CRITICAL' },
];

/**
 * Scan a directory for supply chain security issues before publish.
 */
export function scanDirectory(dir: string, opts: {
  maxFileSize?: number;
  maxDepth?: number;
} = {}): ScanResult {
  const maxFileSize = opts.maxFileSize ?? 10 * 1024 * 1024; // 10MB
  const maxDepth = opts.maxDepth ?? 10;
  const issues: ScanIssue[] = [];
  const sourceMapFiles: string[] = [];
  const secretFiles: string[] = [];
  let filesScanned = 0;

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip node_modules, .git, etc.
      if (['node_modules', '.git', '.next', '__pycache__', 'venv', '.venv'].includes(entry)) continue;

      const fullPath = join(currentDir, entry);
      const relPath = relative(dir, fullPath);

      let stat;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (stat.size > maxFileSize) continue;
      filesScanned++;

      // Check for source map files
      if (/\.(js|ts|jsx|tsx|css|mjs|cjs)\.map$/i.test(entry)) {
        sourceMapFiles.push(relPath);
        issues.push({
          type: 'source_map',
          severity: 'HIGH',
          file: relPath,
          detail: `Source map file found — contains full original source code (${(stat.size / 1024).toFixed(1)}KB)`,
        });

        // Check if source map contains sourcesContent (embedded source)
        try {
          const content = readFileSync(fullPath, 'utf8');
          if (content.includes('"sourcesContent"')) {
            issues.push({
              type: 'sourcesContent',
              severity: 'CRITICAL',
              file: relPath,
              detail: 'Source map contains sourcesContent — ENTIRE original source code is embedded and will be published',
            });
          }
        } catch { /* skip unreadable files */ }

        continue;
      }

      // Check for dangerous files that should never be published
      for (const dangerousName of DANGEROUS_FILES) {
        if (entry === dangerousName || relPath.endsWith(dangerousName)) {
          issues.push({
            type: 'env_file',
            severity: 'CRITICAL',
            file: relPath,
            detail: `Sensitive config file found — should not be published: ${dangerousName}`,
          });
        }
      }

      // Check .npmrc for tokens
      if (entry === '.npmrc') {
        try {
          const content = readFileSync(fullPath, 'utf8');
          if (content.includes('_authToken') || content.includes('_auth=')) {
            issues.push({
              type: 'npmrc_token',
              severity: 'CRITICAL',
              file: relPath,
              detail: '.npmrc contains authentication token — will be published to registry',
            });
          }
        } catch { /* skip */ }
      }

      // Scan JS/TS files for sourceMappingURL references
      const ext = extname(entry).toLowerCase();
      if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
        try {
          const content = readFileSync(fullPath, 'utf8');
          if (/\/\/[#@]\s*sourceMappingURL\s*=/.test(content)) {
            issues.push({
              type: 'source_mapping_url',
              severity: 'MEDIUM',
              file: relPath,
              detail: 'File contains sourceMappingURL reference — may expose source map location',
            });
          }

          // Scan for embedded secrets in build output
          for (const { name, pattern, severity } of SECRET_PATTERNS) {
            if (pattern.test(content)) {
              secretFiles.push(relPath);
              issues.push({
                type: 'secret',
                severity,
                file: relPath,
                detail: `${name} found in build artifact`,
              });
              break; // one secret per file is enough
            }
          }
        } catch { /* skip unreadable */ }
      }
    }
  }

  walk(dir, 0);

  return {
    safe: issues.length === 0,
    issues: issues.sort((a, b) => {
      const sev = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return sev[a.severity] - sev[b.severity];
    }),
    files_scanned: filesScanned,
    source_maps_found: sourceMapFiles,
    secrets_found: [...new Set(secretFiles)],
  };
}

/**
 * Check if an .npmignore or package.json files field properly excludes .map files.
 */
export function checkPublishConfig(dir: string): {
  has_npmignore: boolean;
  excludes_maps: boolean;
  has_files_field: boolean;
  files_field_safe: boolean;
  recommendations: string[];
} {
  const recommendations: string[] = [];

  // Check .npmignore
  const npmignorePath = join(dir, '.npmignore');
  let hasNpmignore = false;
  let excludesMaps = false;
  if (existsSync(npmignorePath)) {
    hasNpmignore = true;
    try {
      const content = readFileSync(npmignorePath, 'utf8');
      excludesMaps = /\*\.map\b/.test(content) || /\*\*\/\*\.map/.test(content);
    } catch { /* skip */ }
  }

  // Check package.json "files" field
  const pkgPath = join(dir, 'package.json');
  let hasFilesField = false;
  let filesFieldSafe = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.files && Array.isArray(pkg.files)) {
        hasFilesField = true;
        // Safe if no pattern would include .map files
        filesFieldSafe = !pkg.files.some((f: string) =>
          f === '.' || f === '*' || f.includes('.map') || f === 'dist' || f === 'dist/'
        );
        // "dist" or "dist/" would include .map files in dist/ — not safe
        if (pkg.files.includes('dist') || pkg.files.includes('dist/')) {
          filesFieldSafe = false;
        }
      }
    } catch { /* skip */ }
  }

  if (!hasNpmignore && !hasFilesField) {
    recommendations.push('Add "*.map" to .npmignore or use a "files" whitelist in package.json');
  }
  if (hasNpmignore && !excludesMaps) {
    recommendations.push('Add "*.map" to .npmignore to exclude source maps from published package');
  }
  if (hasFilesField && !filesFieldSafe) {
    recommendations.push('Your "files" field may include .map files — use explicit file patterns like "dist/**/*.js" instead of "dist"');
  }
  if (!hasNpmignore && hasFilesField && filesFieldSafe) {
    // files field is safe, no recommendation needed
  }

  return {
    has_npmignore: hasNpmignore,
    excludes_maps: excludesMaps,
    has_files_field: hasFilesField,
    files_field_safe: filesFieldSafe,
    recommendations,
  };
}
