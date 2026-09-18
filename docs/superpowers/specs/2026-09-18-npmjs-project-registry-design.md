# Project npm Registry Design

## Goal

Use the public npm registry for dependency installation, package queries, and publishing in this repository without changing the user's global npm configuration.

## Design

Add a repository-level `.npmrc` containing `registry=https://registry.npmjs.org/`. npm and pnpm discover this file from the project root, so commands executed in this repository use npmjs.org while other repositories retain their existing registry configuration.

No authentication token is stored in the repository. Publishing still requires the user to authenticate with npmjs.org through npm's normal credential storage.

## Verification

Run `npm config get registry` from the repository root and require it to return `https://registry.npmjs.org/`.
