# NewsPulse Reel Renderer

GitHub Actions renderer for NewsPulse Instagram Reels (news-card-v10).
Push a render request JSON to `render-requests/`, the Action renders a
1080x1920 MP4 + cover + manifest and deploys them to GitHub Pages.

## Render request

`render-requests/<request_id>.json`:

```json
{
  "reelVideoUrl": "https://...",
  "inputKind": "image | video | wan-video",
  "targetDurationSec": 15,
  "headline": "...",
  "captionCards": ["...", "..."],
  "instagramCaption": "...",
  "sourceTitle": "...",
  "sourceUrl": "https://...",
  "sourcePublisher": "Forbes",
  "brandName": "NEWS PULSE",
  "backgroundMusicUrl": "https://..."
}
```

## Output (GitHub Pages)

- `https://<user>.github.io/newspulse-reel-renderer/reels/<request_id>/reel.mp4`
- `https://<user>.github.io/newspulse-reel-renderer/reels/<request_id>/cover.jpg`
- `https://<user>.github.io/newspulse-reel-renderer/requests/<request_id>.json` (manifest, `status: "ready"`)

## Local test

```bash
node render.mjs --payload render-requests/<id>.json
# needs REQUEST_ID and BASE_URL env, plus ffmpeg installed
```
