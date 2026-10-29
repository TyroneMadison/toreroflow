# Brand fonts

The two typefaces `Torerone_Portfolio_Canva.pptx.pdf` is set in, kept here so
the game plan PDF matches the portfolio exactly.

| File | Family | Source |
|---|---|---|
| `anton-latin.woff2` | Anton, regular, latin subset | Google Fonts, `fonts.gstatic.com/s/anton/v27` |
| `montserrat-latin-var.woff2` | Montserrat, variable 100 to 900, latin subset | Google Fonts, `fonts.gstatic.com/s/montserrat/v31` |

Both are licensed under the **SIL Open Font License 1.1**, which permits
embedding in documents and bundling with software. Anton is copyright the
Anton Project Authors; Montserrat is copyright the Montserrat Project
Authors. Full text: <https://openfontlicense.org>.

## How they reach the PDF

They are base64 data URIs inside `assets/insights-template.html`, not
references to these files. The renderer writes that template to a temp
directory and prints it through headless Chrome with no network, so a
relative or remote font URL would resolve to nothing and silently fall back.

These copies are the originals, kept for provenance and so the template can
be regenerated if the embedded copies ever need replacing:

```bash
node -e "const fs=require('fs');const b=n=>fs.readFileSync('assets/fonts/'+n).toString('base64');console.log(b('anton-latin.woff2').length)"
```

## Caption rendering (libass)

libass cannot read woff2, so the Studio Edit renderer's `fontsdir` needs TTFs.
These are the same families, full character set, from `github.com/google/fonts`
(OFL 1.1, same licence as above):

| File | Family |
|---|---|
| `Anton-Regular.ttf` | Anton |
| `Montserrat-Regular.ttf`, `-Bold`, `-ExtraBold`, `-Black` | Montserrat, static instances of the variable font (fontTools `instancer`, wght 400/700/800/900) |

Static instances rather than the variable file because libass picks weights
by named face, and a variable TTF only exposes its default instance. Liberation
Sans/Serif come from the OS (`fonts-liberation` in the Docker image).

## Caption emojis

`NotoEmoji-Regular.ttf` is Noto Emoji (monochrome, variable weight) from
`github.com/google/fonts/ofl/notoemoji`, SIL Open Font License 1.1,
copyright Google LLC. libass has no color emoji support, so burned-in
caption emojis use this outline font by name (`\fnNoto Emoji`) through the
same fontsdir as the other caption fonts.
