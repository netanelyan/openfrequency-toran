# OpenFrequency brand marks

One family: rounded square (rx 24 on a 100 viewBox), one white mark, one color per product.

| Mark | Color | Meaning |
| --- | --- | --- |
| OpenFrequency | #2747D6 | Halftone, dots grow toward the center |
| Teder (תדר) | #6A3FD6 | One wave, like a tilde |
| Toran (תורן) | #0F7A54 | Three "typing..." dots |

Files:
- `svg/<name>.svg` - app icon with background.
- `svg/<name>-glyph.svg` - the mark only, `currentColor`, for inline use on a colored tile.
- `svg/openfrequency-small.svg`, `svg/openfrequency-glyph-small.svg` - simpler 5x5 halftone. Use it at 48px and below, where the full halftone's smallest dots vanish.
- `png/<name>-180.png`, `png/<name>-512.png` - apple-touch and manifest icons.
- `png/toran-180.png` is a full square (iOS rounds it itself; a transparent corner would show black), `png/toran-192.png` is the manifest's 192, and `png/toran-maskable-192.png`, `png/toran-maskable-512.png` are the mark on a full square for Android's launcher to cut.

Rules: keep the colors exact, never stretch or recolor the mark, keep at least 1/8 of the icon size as clear space.
