# Tinybot Help Center

[Read the handbook](https://sudojacky.github.io/tinybot/).

The Chinese user handbook is a standalone VitePress site. Only `content/` is
published. Dependencies are separate from the desktop application.

## Local development

From the repository root, with Node.js 22 or newer:

```sh
npm ci --prefix website
npm run help:dev
npm run help:build
npm run help:preview
```

Open the printed URL including `/tinybot/`. The production build checks internal
links. Restart the preview server after rebuilding.

## Content and images

Edit articles in `content/` and navigation in `.vitepress/config.mts`. Keep user
instructions aligned with the current application labels and behavior.

Screenshots live in `content/public/screenshots/`; their IDs, captions, and alt
text are registered in `.vitepress/theme/screenshots.json`. Use real application
captures in WebP format. Concept illustrations live in
`content/public/illustrations/` and are identified as illustrations in the articles.

## Deployment and dependencies

`.github/workflows/help-pages.yml` builds site changes on pull requests and
deploys pushes to `master` through GitHub Pages. The repository's Pages source
is GitHub Actions. Check the workflow and public site after deployment.

VitePress 1.6.4 uses a Vite 6.4.3 override for the
[Windows development-server path fix](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
and newer esbuild. Recheck this override when upgrading VitePress.
