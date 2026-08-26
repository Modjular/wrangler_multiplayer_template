import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(rootDir, "package.json");
const versionJsonPath = join(rootDir, "public", "version.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;

pkg.version = nextVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(
  versionJsonPath,
  JSON.stringify({ version: nextVersion, deployedAt: new Date().toISOString() }, null, 2) + "\n"
);

console.log(`Bumped version to v${nextVersion}`);
