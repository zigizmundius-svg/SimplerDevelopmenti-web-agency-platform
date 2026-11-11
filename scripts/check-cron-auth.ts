import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const cronRoot = join(process.cwd(), 'app/api/cron');

function collectRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(absolutePath);
    return entry.isFile() && entry.name === 'route.ts' ? [absolutePath] : [];
  });
}

const routeFiles = collectRouteFiles(cronRoot);
const failures: string[] = [];

for (const file of routeFiles) {
  const source = readFileSync(file, 'utf8');
  const hasSharedGuardImport =
    /import\s*\{\s*isAuthorizedCron\s*\}\s*from\s*['"]@\/lib\/cron-auth['"]/.test(source);
  const hasGuardInvocation = /\bisAuthorizedCron\s*\(\s*(?:req|request)\b/.test(source);

  if (!hasSharedGuardImport || !hasGuardInvocation) {
    const missing = [
      !hasSharedGuardImport ? 'shared guard import' : null,
      !hasGuardInvocation ? 'guard invocation' : null,
    ].filter(Boolean).join(' and ');
    failures.push(`${relative(process.cwd(), file)}: missing ${missing}`);
  }
}

if (routeFiles.length === 0) {
  failures.push('No app/api/cron/**/route.ts files were found; check the scanner root.');
}

if (failures.length > 0) {
  console.error('Cron authentication inventory failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Cron authentication inventory passed: all ${routeFiles.length} route files import and invoke isAuthorizedCron.`);
}
