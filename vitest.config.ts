import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Mirror tsconfig's `@/*` path mapping so component modules under test
      // resolve their `@/components/...` imports.
      { find: "@", replacement: repoRoot },
    ],
  },
  test: {
    environment: "node",
    // The 5s vitest default is too tight for this suite under machine load.
    // Heavy app-render tests (tests/app-group-create-assign.test.tsx among
    // them) timed out at 5s only when several suites ran at once, and the
    // same red reproduced on untouched dev with the same node_modules, so
    // the failures were the default and not the code: one suite took 59s
    // idle versus 204-261s under a load average of 86-120. 20s keeps a
    // genuinely hung test failing, just later than it used to.
    testTimeout: 20_000,
    // No test runs the real acli/gh: lib/jira-exec's runTool is mocked for
    // every file (tests/helpers/no-real-tools.ts).
    setupFiles: ["tests/helpers/no-real-tools.ts"],
    // Sibling worktrees live in `.worktrees/` and each carries the whole
    // repo's tests; without this exclude a run from a checkout that hosts
    // worktrees double-runs every suite against foreign working trees
    // (their fixtures resolve against this checkout's generated files, so
    // most of the doubles fail). Everything else keeps vitest's defaults.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      '**/.{idea,git,cache,output,temp}/**',
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/.worktrees/**",
    ],
  },
});
