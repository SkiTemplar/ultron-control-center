---
name: hyperframes
description: Open-source video rendering framework by HeyGen. Enables authoring video compositions using HTML and GSAP.
kind: skill
tier: L1
category: workflow
last_verified: 2026-05-03
tags: [hyperframes]
token_est: 365
layer: L1-skills
---

# Hyperframes: HTML-to-Video Composition

Teaches the agent how to write HTML compositions that the Hyperframes engine can render into deterministic MP4/MOV video.

## Core Rules
1. **Root Element**: Must have `data-composition-id`, `data-width`, and `data-height`.
2. **Timed Elements**: Every visual layer (clip) must have `class="clip"`, `data-start="[seconds]"`, `data-duration="[seconds]"`, and `data-track-index="[integer]"`.
3. **GSAP Timelines**: Must be created with `{ paused: true }` and registered on `window.__timelines`.

## Commands
- `/hyperframes`: Author a new composition or edit an existing one.
- `/hyperframes-cli`: Access CLI tools (`init`, `lint`, `preview`, `render`).
- `/gsap`: Get help with GSAP animation logic within a composition.

## Composition Schema Example
```html
<div data-composition-id="my-video" data-width="1920" data-height="1080">
  <div class="clip" data-start="0" data-duration="5" data-track-index="1">
    <h1>Hello World</h1>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("h1", { opacity: 0, duration: 1 });
    window.__timelines = [tl];
  </script>
</div>
```

## Validation
Always run `npx hyperframes lint` after editing to ensure the HTML structure is valid.
