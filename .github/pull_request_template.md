## Summary

Describe what changed and why. Keep the scope narrow enough to review and revert safely.

## Validation

List the commands, fixtures, or manual checks used to validate this change. Run the product checks from the `vendor/codemem` workspace.

- [ ] `cd vendor/codemem && corepack pnpm run build`
- [ ] `cd vendor/codemem && corepack pnpm run tsc`
- [ ] `cd vendor/codemem && corepack pnpm run lint`
- [ ] `cd vendor/codemem && CI=true corepack pnpm run test:coverage`
- [ ] Other validation is documented below, or a reason is given for skipped checks.

## Safety and compatibility

- [ ] No real credentials, private memory content, database files, or private local paths are included.
- [ ] Sole-writer, authentication, redaction, spool/replay, backup, and fail-open invariants remain intact or their changes are explicitly documented.
- [ ] Breaking RPC, schema, configuration, migration, or adapter changes are identified.
- [ ] New or changed third-party material has clear provenance and its notices are updated when required.
- [ ] Documentation and tests were updated where behavior changed.

## Additional context

Include relevant issue links, screenshots, benchmark results, migration notes, or rollback instructions.
