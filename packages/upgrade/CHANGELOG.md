# @atlasauth/upgrade changelog

## 0.1.0

First published release.

### Added
- `atlas-upgrade` CLI with `--dry` (print a diff, write nothing) and `--yes` (apply) modes.
- Clerk-to-Atlas codemod: rewrites `@clerk/*` imports, renamed components, hooks and middleware, and `CLERK_*` environment variables to their Atlas equivalents; unmapped cases are marked with a `TODO(atlas-upgrade):` comment.
- Version bump: updates `@atlasauth/*` dependency ranges in `package.json` (`bumpAtlasDeps()`).
- Programmatic API: `runClerkToAtlas()`, `clerkToAtlas` transform, `unifiedDiff()`, `main()` / `parseCliArgs()`, and the `PACKAGE_MAP` / `IDENTIFIER_MAP` mappings.
