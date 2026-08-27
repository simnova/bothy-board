export function migrationName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function isMigrationFile(path: string): boolean {
  return path.endsWith(".sql");
}

export function pendingMigrations(
  paths: Iterable<string>,
  applied: Iterable<string>,
): Array<{ name: string; path: string }> {
  const done = new Set(applied);
  return [...paths]
    .filter(isMigrationFile)
    .map((path) => ({ name: migrationName(path), path }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(({ name }) => !done.has(name));
}
