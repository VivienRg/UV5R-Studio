# Contributing to UV5R Studio

Thank you for helping improve UV5R Studio. Contributions through GitHub issues and pull requests are welcome.

## Before you start

1. Search existing issues and pull requests to avoid duplicating work.
2. For bugs, open a bug report with reproducible steps and environment details.
3. For substantial features or behavior changes, open a feature request and discuss the approach before investing significant effort.
4. Never include radio credentials, Apple signing material, API keys, recordings containing private conversations, or other sensitive data.

## Development setup

```bash
npm ci
npm start
```

Run the automated test suite:

```bash
npm test
```

The application uses Electron and plain JavaScript. Packaging is configured in `electron-builder.yml`; the Electron entry points are `main.js` and `preload.js`.

## Making a change

1. Fork the repository.
2. Create a focused branch from the `release` branch:

   ```bash
   git switch release
   git pull --ff-only
   git switch -c fix/short-description
   ```

3. Make a small, cohesive change. Add or update tests when behavior changes.
4. Run `npm test` locally.
5. Do not commit generated releases, `node_modules`, `.env` files, certificates, keys, recordings, or local radio backups.
6. Commit with a concise imperative message, such as `Fix APRS checksum validation`.
7. Push the branch to your fork and open a pull request using the provided template.

## Pull-request expectations

A pull request should:

- Explain the problem and the chosen solution.
- Link the related issue when one exists.
- Stay focused; unrelated changes should use separate pull requests.
- Include tests or explain why tests are not applicable.
- Include screenshots for visible interface changes.
- Preserve receive-only defaults and radio safety controls.
- Avoid adding dependencies unless their purpose, licence, and maintenance cost are justified.
- Pass every required GitHub status check before review.

Maintainers may request changes. Keep discussion technical and respectful, and resolve review threads only after the underlying concern has been addressed.

## Radio and security considerations

Changes affecting transmission, frequency limits, licence checks, code-signature checks, IPC, credential storage, or external network requests require particular care. Describe the safety and security impact explicitly in the pull request and add regression coverage where practical.

## Licence

By contributing, you agree that your contribution will be licensed under the repository's MIT License.

## Maintainer merge protection

Repository maintainers should create a branch protection rule or ruleset for `release` in **Settings → Rules → Rulesets**. Require pull requests, at least one approval, resolution of review conversations, and the `Test and package` status check from `.github/workflows/pr-check.yml`. Disable force pushes and direct deletion of the branch. The workflow performs validation, while the repository ruleset makes that validation mandatory before merging.
