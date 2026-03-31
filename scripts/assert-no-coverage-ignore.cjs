const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();
const scanRoots = ['src', 'test', 'bin', 'scripts'];
const skipFiles = new Set(['assert-no-coverage-ignore.cjs']);
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs']);
const coverageIgnorePattern = /\b(?:c8|istanbul|v8)\s+ignore\b/iu;

function collectSourceFiles(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(rootDir, relativePath);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(rootDir, relativePath));
      continue;
    }

    if (skipFiles.has(entry.name)) {
      continue;
    }

    if (!sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

function findViolations(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
  const violations = [];

  lines.forEach((line, index) => {
    if (coverageIgnorePattern.test(line)) {
      violations.push({
        line: index + 1,
        text: line.trim(),
      });
    }
  });

  return violations;
}

const violations = [];

for (const scanRoot of scanRoots) {
  for (const filePath of collectSourceFiles(repoRoot, scanRoot)) {
    for (const violation of findViolations(filePath)) {
      violations.push({
        filePath: path.relative(repoRoot, filePath),
        ...violation,
      });
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    [
      'Coverage ignore pragmas are forbidden in this repo.',
      'Cover edge cases with tests instead of c8/istanbul/v8 ignore directives.',
      '',
      ...violations.map(
        (violation) => `- ${violation.filePath}:${violation.line} ${violation.text}`,
      ),
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write('Coverage ignore guard passed: no forbidden pragmas found.\n');
