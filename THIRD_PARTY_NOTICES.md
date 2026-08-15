# Third-Party Notices

This file records third-party assets and libraries vendored or depended upon by
the pix client visual foundation, ported from the `pi-web-desktop` project.

## pi-web-desktop (MIT License)

The design tokens, `globals.css`, `wallpaper.css`, the pre-paint theme
bootstrap script in `index.html`, the Catppuccin icon set, and the Monet
artwork wallpapers are ported from
[pi-web-desktop](https://github.com/isWittHere/pi-web-desktop) (upstream:
pi-web by agegr), licensed under the MIT License:

> Copyright (c) 2026 agegr (upstream pi-web)
> Copyright (c) 2026 isWittHere (pi-web-desktop)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Catppuccin icons (MIT License)

`packages/client/public/catppuccin-icons/` is copied verbatim (including its
LICENSE file) from pi-web-desktop. Copyright (c) 2023 Catppuccin and
Copyright (c) 2023 thang-nm, licensed under the MIT License (see
`catppuccin-icons/LICENSE` in that directory).

## Fonts

- **iA Writer Quattro** — bundled via `@fontsource/ia-writer-quattro@5.3.0`.
  Copyright © 2018 Information Architects Inc. with Reserved Font Name
  "iA Writer", based on the IBM Plex Typeface (Copyright © 2017 IBM Corp. with
  Reserved Font Name "Plex"). Licensed under the SIL Open Font License,
  Version 1.1.
- **Lilex** — bundled via `@fontsource/lilex@5.3.0`. Copyright 2019 The Lilex
  Project Authors (https://github.com/mishamyrt/Lilex). Licensed under the SIL
  Open Font License, Version 1.1.

## Monet artwork wallpapers

`packages/client/public/monet-artworks/` is copied verbatim from
pi-web-desktop. These JPEG wallpapers are derived works based on paintings by
Claude Monet (1840–1926). The underlying paintings date from the 19th and early
20th centuries and the source project ships them as wallpaper assets without a
per-file provenance record; beyond the above attribution no further
representation is made about the photographic/scans' rights status or
provenance of these specific files.

## Other newly added dependencies

- **@phosphor-icons/react@2.1.10** — MIT License, Copyright (c) 2020 Phosphor
  Icons.
- **katex@0.16.47** (CSS only at this stage) — MIT License, Copyright (c)
  2013-2020 Khan Academy and other contributors.
- **tailwindcss@4.2.2 / @tailwindcss/vite@4.2.2** — MIT License (Tailwind Labs).
