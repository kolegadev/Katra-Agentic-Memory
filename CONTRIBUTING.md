# Contributing to Katra

Thank you for your interest in contributing to Katra! This document provides guidelines for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)
- [Security](#security)

## Code of Conduct

This project is committed to providing a welcoming and inclusive experience for everyone. We expect all contributors to be respectful and constructive in all interactions. All participants are expected to follow the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/kolegadev/Katra-Agentic-Memory.git`
3. Create a feature branch: `git checkout -b feature/my-feature`
4. Make your changes
5. Push to your fork and submit a pull request

## Development Setup

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- (Optional) Python 3.10+ for watcher scripts

### Local Development

```bash
# Install server dependencies (npm >= 11 required)
cd server
npm install

# Run tests
npm test

# Typecheck and build (what CI runs)
npm run typecheck
npm run build

# Start development server (requires MongoDB + Redis running)
npm run dev
```

### Docker Development

```bash
# Build and run with live code reload
docker-compose up -d --build
```

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Follow the existing code style (`npm run format` uses Prettier)
- Run `npm run typecheck` before committing — CI enforces it
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Write unit tests for new functionality

### Python (watchers & integrations)

- Follow PEP 8 style guide
- Use type hints
- Include docstrings for modules and functions

### Git Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat: add new feature
fix: correct a bug
docs: update documentation
refactor: restructure code
test: add or update tests
security: address vulnerability
chore: maintenance tasks
```

## Pull Request Process

1. Ensure your code passes all existing tests
2. Add tests for new functionality
3. Update documentation if needed
4. Keep PRs focused on a single concern
5. Reference any related issues in the PR description
6. Request review from maintainers

## Reporting Issues

When reporting issues, please include:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected vs actual behavior
- Environment details (OS, Docker version, Node.js version)
- Logs or error messages if available

## Security

If you discover a security vulnerability, please **do not** open a public issue. Instead, refer to our [SECURITY.md](SECURITY.md) for responsible disclosure.
