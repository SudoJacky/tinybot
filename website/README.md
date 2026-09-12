# Tinybot Help Center

The Chinese user handbook is a standalone VitePress site. Its npm dependencies,
lockfile, content, and assets live here; the desktop application build does not
depend on them. Only `content/` is published. Engineering documentation remains
under the repository's `docs/` directory.

VitePress 1.6.4 is the stable release. Its Vite dependency is overridden to
6.4.3 to include the [Windows development-server path fix](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
and the newer esbuild dependency. Recheck the override when upgrading VitePress.

## Develop and verify

From the repository root, with Node.js 22 or newer:

```sh
npm ci --prefix website
npm run help:dev
npm run help:build
npm run help:preview
```

Open the URL printed by VitePress, including `/tinybot/`. Internal Markdown links
are checked during the production build. Broken links fail the build; do not set
`ignoreDeadLinks`. Keep `.html` URLs for GitHub Pages rather than relying on a
server rewrite rule. The search index uses Chinese word segmentation and runs
locally in the reader's browser.

Check the homepage, one guide, local Chinese search, light/dark themes, mobile
navigation, and deep-link reloads after theme or routing changes.

## Screenshots and illustrations

See [SCREENSHOTS.md](./SCREENSHOTS.md) for the capture list and filenames.
`AppScreenshot` resolves a registered ID through `screenshots.data.ts`. A missing
WebP is an explicit editorial placeholder, with a caption and accessible text.
An unknown ID is an error. Adding the matching WebP and rebuilding replaces the
placeholder without editing the article. A broken existing image remains visible
as a broken image; the component does not disguise load failures as placeholders.

The capture registry lives at `.vitepress/theme/screenshots.json`. Keep its
descriptions and the capture list aligned when adding or changing screenshots.
Use real application captures for UI documentation, and label generated concept
art as an illustration. Save raster assets as WebP; retain the existing SVG logo.
The generation prompts are recorded in [ILLUSTRATIONS.md](./ILLUSTRATIONS.md).

## Deploy to GitHub Pages

The workflow is `.github/workflows/help-pages.yml`:

- Pull requests affecting the site build it without deploying.
- Relevant pushes to `master` build and deploy only `.vitepress/dist`.
- Manual runs on `master` also deploy; manual runs on other branches only build.

Before the first deployment, a repository administrator must select **Settings →
Pages → Build and deployment → Source → GitHub Actions**. This is a one-time
repository setting; committing the workflow alone does not enable Pages.

The configured project URL is `https://sudojacky.github.io/tinybot/`. It is a
deployment target, not a claim that the site is already published. The base URL
and favicon prefix are configured in `.vitepress/config.mts`; update both if the
hosting path changes. The `github-pages` environment may require approval if
repository environment protection is enabled.

After deployment, verify the workflow, the formal URL, a guide deep link, search,
and image loading. Do not publish the repository root, `DESIGN`, `CONTEXT`, or
`docs/local/`. Screenshot instructions and this maintainer README are outside
`content/` and do not become public handbook pages.

## Content maintenance

Describe user tasks in Chinese using labels from
`src/react-workbench/i18n/resources/zh.ts`. Verify behavior against the owning
module and maintained engineering docs. Do not invent screenshots, compatibility,
or supported installer platforms. Avoid duplicating provider model catalogs;
link to Releases for available installers.

This first edition was checked against the working checkout on 2026-09-12.
The primary sources were `docs/desktop.md`,
`docs/api/workspace-and-extensions.md`,
`docs/architecture/tool-execution-and-permissions.md`, and the Agent Graph,
settings, chat, and desktop-pet workbench modules. Recheck the corresponding
guide when those user-facing behaviors change.
