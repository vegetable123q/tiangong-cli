import path from 'node:path';

export function resolveTidasSdkPath(...parts: string[]): string {
  return path.resolve(process.cwd(), 'test', 'fixtures', 'tidas-sdk', ...parts);
}
