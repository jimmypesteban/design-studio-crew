# Bundled fonts

Source Sans 3 (body) and Source Serif 4 (headings), the two Moon brand fonts. Both are open fonts under the SIL Open Font License 1.1, and their licence texts sit next to the files.

- `source-sans-3-latin-wght-normal.woff2` and `source-serif-4-latin-wght-normal.woff2` are the variable weight, Latin subset files from the Fontsource packages `@fontsource-variable/source-sans-3` and `@fontsource-variable/source-serif-4`, version 5.3.1.
- They are bundled so every screen, asset and audit renders with the real brand fonts with no network. Text outside the Latin range falls back to the fallbacks in Moon's font stack.
