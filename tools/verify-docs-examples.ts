// Extracts the fenced TypeScript examples from docs/getting-started.md and
// compile-verifies them against the real published package shape, exactly as
// a fresh consumer would see it: the examples are written into a throwaway
// package that npm-installs the packed tarball, then type-checked strictly
// with lib.dom. Guards against examples that drift from the API.
//
// A reader follows the guide top to bottom, so each fence is checked with
// only the fences before it: fence N compiles as fences 1..N in their own
// module. Checking the whole guide as one file would let an import written
// in a later section cover a name an earlier section uses (imports hoist).
//
// Compile-only, deliberately: the runtime surface is browser-side
// (iframe + postMessage), so the examples cannot execute headless without a
// fake DOM that would itself distort them. The failure class docs actually
// suffer — renamed exports, changed signatures, misspelled fields — is
// caught at the type level.
//
// Usage: node tools/verify-docs-examples.ts

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function extractFences(markdownPath: string, language: string): string[] {
  const source = readFileSync(markdownPath, "utf8");
  const fences: string[] = [];
  const pattern = new RegExp("^```" + language + "\\r?\\n([\\s\\S]*?)^```", "gm");
  for (let match; (match = pattern.exec(source)) !== null; ) fences.push(match[1]);
  if (fences.length === 0) throw new Error(`no \`\`\`${language} fences in ${markdownPath}`);
  return fences;
}

function run(command: string, args: string[], cwd: string): void {
  if (process.platform === "win32" && command === "npm") {
    // npm is a .cmd shim on Windows, and Node refuses to spawn .cmd without a
    // shell (CVE-2024-27980 guard). Shell use is confined to this local-dev
    // branch; every argument is a repo-internal constant, never user input.
    execSync([command, ...args.map((a) => JSON.stringify(a))].join(" "), { cwd, stdio: "pipe" });
  } else {
    execFileSync(command, args, { cwd, stdio: "pipe" });
  }
}

// The README's quickstart is the first code a registry consumer reads (it is
// the one document inside the tarball), so it is checked too — as its own
// sequence, since it does not build on the guide.
const documents = [
  { label: "readme", fences: extractFences(join(repoRoot, "README.md"), "ts") },
  { label: "guide", fences: extractFences(join(repoRoot, "docs", "getting-started.md"), "ts") },
];
const consumer = mkdtempSync(join(tmpdir(), "vivarium-docs-ts-"));
try {
  // Consume the runtime the way a registry consumer would: pack a tarball
  // (prepack builds dist/) and install that — not a symlink or folder link.
  const { name, version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const tarball = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
  run("npm", ["install", "--no-audit", "--no-fund"], repoRoot);
  run("npm", ["pack", "--pack-destination", consumer], repoRoot);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "docs-consumer", private: true, type: "module",
  }));
  run("npm", ["install", "--no-audit", "--no-fund", tarball], consumer);
  const files = documents.flatMap(({ label, fences }) =>
    fences.map((_, index) => {
      const file = `${label}-through-fence-${String(index + 1).padStart(2, "0")}.ts`;
      writeFileSync(join(consumer, file), fences.slice(0, index + 1).join("\n") + "\nexport {};\n");
      return file;
    }),
  );
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "es2022",
      module: "esnext",
      moduleResolution: "bundler",
      lib: ["es2022", "dom", "dom.iterable"],
    },
    files,
  }));
  run("node", [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", consumer], consumer);
  const counts = documents.map(({ label, fences }) => `${label} ${fences.length}`).join(" · ");
  console.log(`PASS docs — fences (${counts}) type-checked against the packed tarball, each with only the fences before it`);
} catch (error: any) {
  console.error(`FAIL — ${error.message}`);
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  process.exit(1);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
