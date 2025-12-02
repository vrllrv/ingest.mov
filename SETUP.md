# Cloudflare Workers Static Site Setup

## Overview
This project uses Cloudflare Workers to serve a static site with HTML, CSS, and JavaScript. The setup is optimized for long-term maintainability.

## Architecture

### Best Practice Approach (Approach A)
Instead of keeping files in separate places, all content is bundled in `src/index.js` where it's served by the Cloudflare Worker.

**Files:**
- `src/index.js` - Main Worker file that serves all static content (HTML, CSS, JS)
- `src/shader.js` - Extracted shader code (can be edited separately if preferred)
- `index.html`, `style.css` - Local reference files
- `wrangler.toml` - Cloudflare Workers configuration

## Current Content

### Title & Branding
- **Title:** INGEST.MOV
- **Subtitle:** motion picture delivery

### Features
- Interactive ASCII art shader with mouse tracking
- Touch controls:
  - Single finger: chaotic flow
  - Two fingers: ultra intense chaotic + character shuffle
  - Double tap: cycle through 3 shader patterns
- Responsive canvas animation
- Custom Degular font family

## How to Edit

### Option 1: Edit in `src/index.js` (Recommended)
Directly modify the string content in `src/index.js`:
- HTML content (lines 21-38): Update title, subtitle, or page structure
- CSS content (lines 41-80): Modify styles
- JavaScript content (lines 83-214): Update shader logic, characters, or behavior

### Option 2: Edit separate files and sync
1. Edit `index.html`, `style.css`, or `src/shader.js`
2. Copy the content into the corresponding section in `src/index.js`
3. Deploy

## Deployment

```bash
# Install dependencies (first time only)
npm install

# Deploy to Cloudflare Workers
npm run deploy
```

Site will be live at: `https://site.ingest-mov.workers.dev`

## Configuration

- **Worker name:** `site`
- **Compatibility date:** 2025-12-02
- **Type:** JavaScript service worker
- **Entry point:** `src/index.js`

## Important Notes

- All content is served from the Worker - changes to local HTML/CSS files won't appear unless you update `src/index.js`
- The `?raw` import syntax is not used to maintain compatibility with Cloudflare Workers
- Content is bundled at deployment time, not at build time
- Wrangler warning about `type` field in `wrangler.json` is harmless

## Next Steps for Long-term Use

To further improve this setup, consider:
1. Setting up a build script that reads separate files and injects them into `src/index.js`
2. Using Wrangler's asset bundling with proper module imports
3. Adding GitHub Actions for automated deployment on push
