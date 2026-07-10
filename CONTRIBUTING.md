# Contributing to OninOneProxy

First off, thank you for taking the time to contribute! 🎉

OninOneProxy is a community-driven project and we welcome contributions of all kinds — bug reports, feature ideas, documentation improvements, code fixes, and more.

This document describes how to get involved.

## Attribution

OninOneProxy is a derivative work based on [9Router](https://github.com/decolua/9router) by **decolua**, used under the MIT License. We are grateful to the original author and contributors of 9Router for the foundation that made OninOneProxy possible.

## Code of Conduct

By participating in this project you agree to abide by its [Code of Conduct](./CODE_OF_CONDUCT.md). Please read it before contributing.

## How to Contribute

### 1. Fork & Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/<your-username>/OninOneProxy.git
cd OninOneProxy
git remote add upstream https://github.com/Vincent-A-Yang/OninOneProxy.git
```

### 2. Create a Branch

```bash
git checkout -b feat/your-feature-name
# or
git checkout -b fix/issue-123
```

### 3. Make Your Changes

- Follow the code style described below.
- Write or update tests when you change behavior.
- Keep commits focused and well-described.

### 4. Commit

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

Common types:

| Type       | Use for                                  |
|------------|------------------------------------------|
| `feat`     | A new feature                            |
| `fix`      | A bug fix                                |
| `docs`     | Documentation only changes               |
| `style`    | Code style (formatting, no logic change) |
| `refactor` | Refactoring (no feature, no fix)         |
| `perf`     | Performance improvement                  |
| `test`     | Adding or correcting tests               |
| `chore`    | Build, tooling, deps, CI                 |

Example:

```
feat(smart-router): add round-robin fallback policy

Switches the secondary fallback to round-robin when the primary
weighted strategy fails repeatedly. Adds unit tests for the new
selector.
```

### 5. Push & Open a Pull Request

```bash
git push origin feat/your-feature-name
```

Open a PR against the `main` branch of `Vincent-A-Yang/OninOneProxy`. Fill in the PR template — describe **what** changed, **why**, and **how it was tested**.

## Code Style

We use **ESLint** and **Prettier** to keep the codebase consistent.

```bash
# Lint
npx eslint .

# Format
npx prettier --write .
```

General rules:

- 2-space indentation
- Single quotes for strings
- No trailing whitespace
- Meaningful variable and function names
- Keep functions small and focused

## Testing

We use **Vitest** for tests.

```bash
# Run the full suite
npm test

# Run in watch mode during development
npx vitest
```

Requirements:

- New code paths should be covered by tests.
- Bug fixes should include a regression test.
- All tests must pass before a PR is merged.

## Reporting Bugs

Use the [Bug Report template](https://github.com/Vincent-A-Yang/OninOneProxy/issues/new?template=bug_report.yml) and include:

- A clear description of the bug
- Steps to reproduce
- Expected vs. actual behavior
- OninOneProxy version and deployment method (Docker / npm / bun)

## Suggesting Features

Use the [Feature Request template](https://github.com/Vincent-A-Yang/OninOneProxy/issues/new?template=feature_request.yml). Explain the problem you are trying to solve before describing the solution.

## Pull Request Review

- A maintainer will review your PR. Expect feedback — it is normal and constructive.
- Address review comments by pushing new commits (do not force-push unless asked).
- Once approved, a maintainer will merge your PR.

## License

By contributing, you agree that your contributions will be licensed under the **MIT License**, the same license that covers the project. See [LICENSE](./LICENSE) for details.

---

Questions? Open a [Discussion](https://github.com/Vincent-A-Yang/OninOneProxy/discussions) or an issue. Happy hacking! 🚀
