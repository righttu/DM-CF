import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(appDir, "../..");
const linkPath = path.join(rootDir, ".devin", "agent-demo", "node_modules");
const target = path.relative(path.dirname(linkPath), path.join(appDir, "node_modules"));

if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
  const stat = fs.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    console.error(`refusing to replace existing non-symlink at ${linkPath}`);
    process.exit(1);
  }
  const existing = fs.readlinkSync(linkPath);
  const resolvedExisting = path.resolve(path.dirname(linkPath), existing);
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  if (resolvedExisting === resolvedTarget) {
    process.exit(0);
  }
  console.error(`existing symlink at ${linkPath} points to ${existing}; refusing to overwrite`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(linkPath), { recursive: true });
fs.symlinkSync(target, linkPath, "dir");
console.log(`linked ${linkPath} -> ${target}`);
