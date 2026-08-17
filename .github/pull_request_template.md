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

## Provenance and license

- [ ] Every commit is signed off (`git commit -s`), certifying the [DCO](https://developercertificate.org/).
- [ ] This contribution is offered under the repository's license (Apache-2.0, inbound = outbound).
- [ ] No third-party code was copied in without recording its upstream URL, commit, and license, and
      without updating `THIRD_PARTY_NOTICES.md` in this same pull request.
- [ ] AI assistance, if any, is declared below (which tool, and confirmation that the output was
      reviewed and does not reproduce third-party code).

## Additional context

Include relevant issue links, screenshots, benchmark results, migration notes, or rollback instructions.
