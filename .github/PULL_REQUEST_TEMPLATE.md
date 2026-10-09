<!--
PR title MUST be Conventional Commits (the required `pr-title` check, and the
squash-merge subject release-please parses for the version bump):
  <type>(optional-scope)(optional-!): <lowercase subject, no trailing period>   (<= 72 chars)
-->

## Summary

## Test plan

<!-- `bash scripts/verify.sh` at minimum. -->

## Checklist

- [ ] `bash scripts/verify.sh` passes (actionlint + shellcheck + node --test)
- [ ] Input/output changes are reflected in the `action.yml` descriptions **and** the README
- [ ] No `${{ }}` inside any `run:` script; untrusted text stays out of shells and format strings
- [ ] A new behaviour has a test; a new wrangler-output shape has a real fixture
