// Release: bump the package version, regenerate CHANGELOG.md with git-cliff,
// commit both, and tag the commit. Pushing and publishing stay manual.
//
//   pnpm release [--dry-run] [patch | minor | major | <x.y.z>]
//
// Without a version, git-cliff picks the next one from the conventional
// commits since the last tag (a feature bumps minor, a fix patch, a breaking
// change major). Before the first tag, the default is the version in
// package.json, so the first release tags what is already there.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => a !== "--dry-run");
if (positional.length > 1) fail("usage: pnpm release [--dry-run] [patch | minor | major | <x.y.z>]");
const requested = positional[0];

function run(command: string, commandArgs: readonly string[], inherit = false): string {
  const output = execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }) as string | null;
  return (output ?? "").trim();
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

type Version = [number, number, number];

function parse(version: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const format = (v: Version) => v.join(".");

const packageFile = "package.json";
const pkg = JSON.parse(readFileSync(packageFile, "utf8")) as { version: string };
const current = parse(pkg.version) ?? fail(`package.json version ${pkg.version} is not x.y.z`);

const tags = run("git", ["tag", "--list", "v*"])
  .split("\n")
  .filter((t) => parse(t));
const latestTag = tags
  .map((t) => parse(t)!)
  .sort(compare)
  .at(-1);

function nextVersion(): Version {
  const base = latestTag ?? current;
  switch (requested) {
    case undefined: {
      if (!latestTag) return current;
      const bumped = parse(run("pnpm", ["exec", "git-cliff", "--bumped-version"]));
      return bumped ?? fail("git-cliff did not return a version");
    }
    case "patch":
      return [base[0], base[1], base[2] + 1];
    case "minor":
      return [base[0], base[1] + 1, 0];
    case "major":
      return [base[0] + 1, 0, 0];
    default:
      return parse(requested) ?? fail(`${requested} is not patch, minor, major or x.y.z`);
  }
}

const next = nextVersion();
const tag = `v${format(next)}`;

if (tags.includes(tag)) fail(`tag ${tag} already exists`);
if (latestTag && compare(next, latestTag) <= 0) fail(`${tag} is not after the latest tag v${format(latestTag)}`);
if (compare(next, current) < 0) fail(`${tag} is before the package version ${pkg.version}`);

if (dryRun) {
  console.log(`release: would release ${tag} (package.json ${pkg.version})\n`);
  console.log(run("pnpm", ["exec", "git-cliff", "--unreleased", "--tag", tag, "--strip", "header"]));
  process.exit(0);
}

if (run("git", ["status", "--porcelain"]) !== "") fail("the working tree has changes; commit or stash them first");
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`releases are made from main, not ${branch}`);

console.log(`release: checking before ${tag}`);
run("pnpm", ["run", "check"], true);

if (compare(next, current) !== 0) {
  pkg.version = format(next);
  writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
}
run("pnpm", ["exec", "git-cliff", "--tag", tag, "--output", "CHANGELOG.md"]);
run("pnpm", ["exec", "prettier", "--write", "CHANGELOG.md", packageFile]);

run("git", ["add", "CHANGELOG.md", packageFile]);
run("git", ["commit", "--quiet", "-m", `chore(release): ${tag}`]);
run("git", ["tag", "--annotate", tag, "-m", `pi-percy ${tag}`]);

console.log(`release: committed and tagged ${tag}. To publish:
  git push --follow-tags origin main
  npm publish`);
