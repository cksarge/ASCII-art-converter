# ASCII Art Converter

A static, dependency-free web app that turns images into ASCII art. Everything runs in the browser, so images never leave your device.

## Features

- **Input:** pick a file, drag and drop (including images dragged from other tabs), paste with Ctrl/⌘+V, or use the built-in sample
- **Character sets:** Standard, Detailed (70 levels), Simple, Blocks (`░▒▓█`), Braille (2×4 dots per character, the highest resolution), Binary, or your own
- **Tone:** brightness, contrast, auto levels, invert, and dithering (Floyd–Steinberg or ordered/Bayer)
- **Output:** tuned for a dark or light background, with optional per-character color
- **Export:** copy as plain text, copy as a ``` code block (keeps it monospaced in Discord, GitHub, Slack), or download as `.txt`, `.png` or `.html`

Settings are saved in `localStorage`.

## Run locally

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a GitHub repo and push these files to the `main` branch:
   ```sh
   git init && git add . && git commit -m "ASCII art converter"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.
3. After a minute or so the site is live at `https://<you>.github.io/<repo>/`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup and controls |
| `style.css` | Styles (follows the system light/dark theme) |
| `app.js` | Image loading, conversion, preview, copy and export |
| `favicon.svg` | Browser tab icon |
| `apple-touch-icon.png` | Home-screen icon for iOS |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

## License

MIT. See [LICENSE](LICENSE).
