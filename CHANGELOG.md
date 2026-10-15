# Changelog

What changed in each version of Deskforce, for people who use it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Installers for each release are on the [Releases page](https://github.com/husseinzayat3/Deskforce/releases).

## [Unreleased]

### Added
- Linux installers: an AppImage for any distribution and a .deb for Debian and Ubuntu. The AppImage updates itself.
- A documentation site at [husseinzayat3.github.io/Deskforce](https://husseinzayat3.github.io/Deskforce/), with new pages on concepts, providers and models, costs and budgets, office files, an FAQ and troubleshooting.
- A shorter README with a demo, screenshots and a comparison with other agent tools.
- A code of conduct and this changelog.
- Examples of real runs with their costs, including one request compared on three models.

### Changed
- Much broader automated tests: every provider's streaming format, whole tasks through the engine, and the office in a real browser, with coverage reported on each pull request.
- The engine and the largest interface components are split into smaller files, and the code no longer uses untyped values. Nothing changes in how the office works.

### Fixed
- Slack: a connection answer without an address now gives a clear error, and events without an id are no longer mistaken for duplicates.

## [0.2.2] - 2026-10-14

### Added
- A Docker image for Intel and ARM machines, published with each release at `ghcr.io/husseinzayat3/deskforce`, so the office runs without a checkout.

### Changed
- The Docker image holds only the self-contained server, which makes it much smaller.
- Every pull request now checks that the Docker image still builds.

## [0.2.1] - 2026-10-14

The first release with installers.

### Added
- Desktop app installers for macOS (Apple Silicon and Intel) and Windows 10 and 11.
- Installed apps check for new versions and update themselves (on macOS once the app is signed).

## 0.1.0 to 0.2.0 - 2026-10-13 to 2026-10-14

Versions used to set up and fix the release pipeline; no installers were published for them.

### Added
- First open-source version of Deskforce under the MIT License: the office, roles and delegation, plans, meetings, reviews and reports, git history and undo, costs and budgets, Slack, checks and the desktop app.
- Contributing guide, security policy, issue and pull request templates, continuous integration and Dependabot.

[Unreleased]: https://github.com/husseinzayat3/Deskforce/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/husseinzayat3/Deskforce/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/husseinzayat3/Deskforce/compare/v0.2.0...v0.2.1
