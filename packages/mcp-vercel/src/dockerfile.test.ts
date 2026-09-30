import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards packages/mcp-vercel/Dockerfile. Nothing else in CI builds it, and a
 * COPY of something that has moved, or that the ignore file excludes, only
 * shows up as a failed deploy on the host.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
// Helm7 builds a nested workspace package with the whole clone as context.
const repoRoot = join(packageDir, "..", "..");

const dockerfile = readFileSync(join(packageDir, "Dockerfile"), "utf8");
const ignoreLines = readFileSync(
  join(packageDir, "Dockerfile.dockerignore"),
  "utf8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

// Same rules as Helm7's context builder (docker-builder.ts compileIgnorePattern),
// which is the stricter of it and Docker: a slash-free pattern matches at any
// depth, a pattern with a slash is anchored to the root.
function compile(raw: string): RegExp {
  const anchored = raw.includes("/");
  const body = raw
    .replace(/\/+$/, "")
    .replace(/^\//, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<globstar>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/<<globstar>>/g, ".*");
  return anchored
    ? new RegExp(`^${body}(?:/.*)?$`)
    : new RegExp(`^(?:.*/)?${body}(?:/.*)?$`);
}

// Excluded from every Helm7 context whatever the ignore file says.
const patterns = [".git", "node_modules", ".next", "._*", ...ignoreLines].map(
  compile,
);
const isExcluded = (path: string) => patterns.some((re) => re.test(path));

function instructions(): string[] {
  // Join backslash continuations so multi-line COPY/ENV read as one line.
  return dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function copySources(): string[] {
  return instructions()
    .filter((line) => /^COPY\s/i.test(line))
    .filter((line) => !/--from=/i.test(line))
    .flatMap((line) => {
      const args = line
        .split(/\s+/)
        .slice(1)
        .filter((arg) => !arg.startsWith("--"));
      return args.slice(0, -1);
    });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("packages/mcp-vercel/Dockerfile", () => {
  it("names at least the workspace files the install needs", () => {
    expect(copySources()).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        "packages/mcp-core",
        "packages/mcp-vercel",
      ]),
    );
  });

  it.each(copySources())("COPY source %s exists in the repository", (src) => {
    expect(existsSync(join(repoRoot, src))).toBe(true);
  });

  it.each(copySources())(
    "COPY source %s is not excluded by Dockerfile.dockerignore",
    (src) => {
      expect(isExcluded(src.replace(/^\.\//, ""))).toBe(false);
    },
  );

  it("does not exclude sources, scripts or manifests inside a copied directory", () => {
    const excluded = copySources()
      .filter((src) => statSync(join(repoRoot, src)).isDirectory())
      .flatMap((src) => walk(join(repoRoot, src)))
      .map((file) => relative(repoRoot, file).split(sep).join("/"))
      .filter((file) =>
        /(^|\/)(src|scripts)\/|(^|\/)(package|tsconfig[^/]*)\.json$/.test(file),
      )
      .filter((file) => !file.endsWith(".test.ts") && isExcluded(file));
    expect(excluded).toEqual([]);
  });

  it("installs with the pnpm version pinned in the root package.json", () => {
    const { packageManager } = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { packageManager: string };
    expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain(
      `corepack prepare ${packageManager} --activate`,
    );
  });

  it("installs from the lockfile without resolving", () => {
    expect(dockerfile).toMatch(
      /pnpm install --filter=@sentry\/mcp-vercel\.\.\. --frozen-lockfile/,
    );
  });

  it("skips install scripts, because @ast-grep/cli's postinstall fails on Alpine", () => {
    // Found by building the image: it ships no musl binary, and its failure
    // fails the whole install even though nothing in the image uses it.
    expect(dockerfile).toMatch(/pnpm install [^\n]*--ignore-scripts/);
  });

  it("runs as a non-root user on the port Helm7 sets, in exec form", () => {
    const lines = instructions();
    const runtime = lines.slice(
      lines.findIndex((line) => /^FROM .* AS runtime$/i.test(line)),
    );
    expect(runtime.some((line) => /^USER\s+(?!root\b)\S+/i.test(line))).toBe(
      true,
    );
    expect(runtime.join("\n")).toMatch(/PORT=3000/);
    expect(runtime).toContain("EXPOSE 3000");
    expect(runtime.at(-1)).toBe('CMD ["node", "dist/start.js"]');
  });

  it("starts the file the build emits", () => {
    const tsconfig = readFileSync(
      join(packageDir, "tsconfig.build.json"),
      "utf8",
    );
    expect(tsconfig).toMatch(/"rootDir":\s*"src"/);
    expect(tsconfig).toMatch(/"outDir":\s*"dist"/);
    expect(existsSync(join(packageDir, "src", "start.ts"))).toBe(true);
  });
});
