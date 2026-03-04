# Contributing to AgentGuard

Thank you for your interest in contributing to AgentGuard! This document provides guidelines and instructions for contributing.

## 🤝 Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct:
- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on what is best for the community
- Show empathy towards other community members

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/Aegis.git`
3. Create a new branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Push to your fork: `git push origin feature/your-feature-name`
6. Create a Pull Request

## 📝 Development Setup

```bash
# Install dependencies
npm install

# Setup Python environment
cd packages/sdk-python
python -m venv venv
source venv/bin/activate
pip install -e ".[dev]"

# Run tests
npm test
```

## 🎯 Pull Request Guidelines

- **One feature per PR**: Keep PRs focused on a single feature or fix
- **Write tests**: All new features should include tests
- **Update documentation**: Keep docs in sync with code changes
- **Follow style guide**: Use the project's coding standards
- **Write clear commit messages**: Use conventional commits format

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance tasks

Example:
```
feat(sdk): add retry logic for network requests

- Implement exponential backoff
- Add max retry configuration
- Handle timeout errors gracefully

Closes #123
```

## 🧪 Testing

All code must pass tests before merging:

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --grep "Gateway"

# Run with coverage
npm run test:coverage
```

## 📚 Documentation

- Update README.md for user-facing changes
- Add JSDoc/docstrings for all public APIs
- Update API documentation for interface changes
- Include examples for new features

## 🐛 Reporting Issues

Before creating an issue:
1. Check existing issues to avoid duplicates
2. Use issue templates when available
3. Provide clear reproduction steps
4. Include system information

## 💡 Feature Requests

We welcome feature requests! Please:
1. Check the roadmap and existing issues first
2. Clearly describe the use case
3. Explain why this feature would benefit users
4. Be open to discussion and alternative solutions

## 🏗️ Architecture Guidelines

- Follow SOLID principles
- Keep functions small and focused
- Use dependency injection
- Write testable code
- Document complex logic

## 🔒 Security

- Never commit secrets or credentials
- Report security issues privately to security@agentguard.ai
- Follow OWASP guidelines
- Validate all inputs
- Use parameterized queries

## 📋 Review Process

1. Automated tests must pass
2. Code review by at least one maintainer
3. Documentation must be updated
4. No merge conflicts
5. Follows project conventions

## 🎉 Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Mentioned in release notes
- Given credit in documentation

Thank you for contributing to AgentGuard! 🛡️