#!/usr/bin/env node
/**
 * NewsPulse Reel Renderer (CLI) — news-card-v10
 *
 * Renders a 1080x1920 Instagram Reel from a background image/video + overlays:
 * brand lockup, headline, timed caption cards, source credit, optional music bed.
 *
 * Usage:
 *   node render.mjs --payload <json-file>
 *   env: REQUEST_ID, PAYLOAD_FILE, BASE_URL, PUBLIC_DIR
 *
 * Payload schema (same as n8n "Build Reel render request" renderRequest):
 *   reelVideoUrl, inputKind, targetDurationSec, headline, captionCards[],
 *   instagramCaption, sourceTitle, sourceUrl, sourcePublisher,
 *   brandName, backgroundMusicUrl, eventDate
 *
 * Output:
 *   <public>/reels/<request_id>/reel.mp4
 *   <public>/reels/<request_id>/cover.jpg
 *   <public>/requests/<request_id>.json  (manifest)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FONT = process.env.REEL_FONT || join(HERE, 'assets', 'NotoSans-Bold.ttf');
const W = 1080;
const H = 1920;
const VERSION = 'news-card-v10';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// Publisher label for the source credit: prefer the workflow-supplied name,
// otherwise derive a readable label from the article hostname.
const hostLabel = (url) => {
  try {
    const first = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    const known = {
      forbes: 'Forbes', techcrunch: 'TechCrunch', theverge: 'The Verge', wired: 'WIRED',
      bbc: 'BBC', reuters: 'Reuters', bloomberg: 'Bloomberg', cnbc: 'CNBC',
      theguardian: 'The Guardian', nytimes: 'NY Times', wsj: 'WSJ',
      arstechnica: 'Ars Technica', engadget: 'Engadget', gizmodo: 'Gizmodo',
      venturebeat: 'VentureBeat', zdnet: 'ZDNet', thehackernews: 'The Hacker News',
      bleepingcomputer: 'BleepingComputer',
    };
    return known[first] || (first.charAt(0).toUpperCase() + first.slice(1));
  } catch { return 'the source'; }
};

const wrap = (value, width, maxLines, charBudget) => {
  const words = clean(value).slice(0, charBudget).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) { line = next; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, width - 1)).trimEnd()}…`;
    return kept.join('\n');
  }
  return lines.join('\n');
};

// Alpha envelope for drawtext: fade in/out around [start, end].
const envelope = (start, end, fade = 0.6) => {
  const s = Number(start).toFixed(2);
  const e = Number(end).toFixed(2);
  const f = Number(fade).toFixed(2);
  return `if(lt(t,${s}),0,if(lt(t,${s}+${f}),(t-${s})/${f},if(lt(t,${e}-${f}),1,if(lt(t,${e}),(${e}-t)/${f},0))))`;
};
const holdIn = (start, fade = 0.7) => {
  const s = Number(start).toFixed(2);
  const f = Number(fade).toFixed(2);
  return `if(lt(t,${s}),0,if(lt(t,${s}+${f}),(t-${s})/${f},1))`;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = args[i + 1];
  }
  return {
    requestId: out.requestId || process.env.REQUEST_ID,
    payloadFile: out.payload || process.env.PAYLOAD_FILE,
    publicDir: out.public || process.env.PUBLIC_DIR || 'public',
    baseUrl: out.baseUrl || process.env.BASE_URL,
  };
}

async function main() {
  const { requestId, payloadFile, publicDir, baseUrl } = parseArgs();

  if (!requestId || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw new Error('request_id must be 8-80 letters, digits, underscores or hyphens');
  }
  if (!baseUrl || !baseUrl.startsWith('https://')) {
    throw new Error('base-url must start with https://');
  }
  if (!payloadFile) throw new Error('Provide --payload <file>');

  const body = JSON.parse(await readFile(payloadFile, 'utf8'));
  const payload = {
    reelVideoUrl: clean(body.reelVideoUrl),
    inputKind: ['wan-video', 'image', 'video'].includes(body.inputKind) ? body.inputKind : null,
    targetDurationSec: Math.min(30, Math.max(5, Number(body.targetDurationSec) || 15)),
    headline: clean(body.headline),
    captionCards: Array.isArray(body.captionCards)
      ? body.captionCards.map((c) => clean(c)).filter(Boolean).slice(0, 3)
      : [],
    instagramCaption: clean(body.instagramCaption),
    sourceTitle: clean(body.sourceTitle),
    sourceUrl: clean(body.sourceUrl),
    sourcePublisher: clean(body.sourcePublisher),
    brandName: clean(body.brandName) || 'NEWS PULSE',
    backgroundMusicUrl: clean(body.backgroundMusicUrl),
    eventDate: clean(body.eventDate),
    hookText: clean(body.hookText),
    voiceoverUrl: clean(body.voiceoverUrl),
  };
  for (const key of ['reelVideoUrl', 'headline', 'sourceTitle', 'sourceUrl']) {
    if (!payload[key]) throw new Error(`Missing render field: ${key}.`);
  }
  if (payload.voiceoverUrl) {
    const vu = new URL(payload.voiceoverUrl);
    if (!['https:', 'http:'].includes(vu.protocol)) throw new Error('Voiceover URL must use HTTP(S).');
  }
  const source = new URL(payload.reelVideoUrl);
  if (source.protocol !== 'https:') throw new Error('Source video must use HTTPS.');

  const work = await mkdtemp(join(tmpdir(), 'newspulse-render-'));
  try {
    const fileName = 'reel.mp4';
    const input = join(work, 'input.bin');
    const outDir = join(publicDir, 'reels', requestId);
    await mkdir(outDir, { recursive: true });
    const output = join(outDir, fileName);

    await run('curl', ['--fail', '--silent', '--show-error', '--location',
      '--max-time', '180', '--output', input, payload.reelVideoUrl],
    { timeout: 200000 });

    // Optional background music bed. Fail-open by design.
    let musicFile = null;
    if (payload.backgroundMusicUrl) {
      try {
        const mu = new URL(payload.backgroundMusicUrl);
        if (mu.protocol !== 'https:') throw new Error('music must be https');
        const candidate = join(work, 'music.bin');
        await run('curl', ['--fail', '--silent', '--show-error', '--location',
          '--max-time', '60', '--output', candidate, payload.backgroundMusicUrl],
        { timeout: 90000 });
        const { stdout: mprobe } = await run('ffprobe',
          ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', candidate],
          { timeout: 30000 });
        if (!String(mprobe).split('\n').some((l) => l.trim() === 'audio')) {
          throw new Error('music has no audio stream');
        }
        musicFile = candidate;
      } catch { musicFile = null; }
    }

    // Voiceover narration. Fail-closed: a silent reel is worse than no reel.
    let voiceFile = null;
    if (payload.voiceoverUrl) {
      const candidate = join(work, 'voice.bin');
      await run('curl', ['--fail', '--silent', '--show-error', '--location',
        '--max-time', '120', '--output', candidate, payload.voiceoverUrl],
      { timeout: 150000 });
      const { stdout: vprobe } = await run('ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', candidate],
        { timeout: 30000 });
      if (!String(vprobe).split('\n').some((l) => l.trim() === 'audio')) {
        throw new Error('voiceover has no audio stream');
      }
      voiceFile = candidate;
    }

    // Probe the download so we can tell stills from video and size loops.
    let probe = null;
    try {
      const { stdout } = await run('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type',
        '-of', 'json', input,
      ], { timeout: 30000 });
      probe = JSON.parse(stdout);
    } catch { probe = null; }
    // Fail fast on bad downloads (expired signed URL, 403 XML, truncated file).
    const probeStreams = probe?.streams || [];
    if (!probe || !probeStreams.length) {
      throw new Error('Downloaded input is not a valid image/video (ffprobe failed) - likely expired URL or bad download');
    }
    const formatName = String(probe?.format?.format_name || '');
    const streams = probe?.streams || [];
    const looksStill = /image|png|jpeg|jpg|webp|bmp|gif/.test(formatName)
      || (streams.length === 1 && streams[0].codec_type === 'video' && !(parseFloat(probe?.format?.duration) > 0.5));
    const probedDuration = parseFloat(probe?.format?.duration) || 0;
    const hasAudio = streams.some((s) => s.codec_type === 'audio');

    let mode = payload.inputKind;
    if (!mode) mode = looksStill ? 'image' : 'video';

    let dur;
    if (mode === 'video') dur = Math.min(30, Math.max(5, probedDuration || 8));
    else dur = payload.targetDurationSec;
    const frames = Math.round(dur * 30);

    // Timed caption cards across the reel.
    let cards = payload.captionCards.slice(0, 2);
    if (!cards.length && payload.instagramCaption) {
      cards = [payload.instagramCaption.split(/\n\s*\n/)[0].slice(0, 150)];
    }
    cards = cards.map((c) => clean(c).slice(0, 150)).filter(Boolean).slice(0, 2);
    // Hook-first opening: giant hook for the first ~2s, then the story layout.
    const hasHook = Boolean(payload.hookText);
    const storyStart = hasHook ? 2.4 : 0.2;
    let windows = [];
    if (cards.length >= 2 && dur >= 13) windows = [[storyStart + 0.2, 7.4], [8.0, Math.min(13.4, dur - 0.8)]];
    else if (cards.length >= 2) windows = [[storyStart + 0.2, dur * 0.45], [dur * 0.52, dur - 0.8]];
    else if (cards.length === 1) windows = [[storyStart + 0.2, Math.max(4, dur - 1.0)]];

    // Text files (drawtext textfile= avoids filter-string injection from copy).
    const headlineFile = join(work, 'headline.txt');
    const cardFiles = [];
    for (let i = 0; i < cards.length; i++) {
      const f = join(work, `card${i}.txt`);
      await writeFile(f, wrap(cards[i], 34, 3, 160), 'utf8');
      cardFiles.push(f);
    }
    const sourceFile = join(work, 'source.txt');
    await writeFile(headlineFile, wrap(payload.headline, 26, 3, 160), 'utf8');
    let dateFile = null;
    if (payload.eventDate) {
      dateFile = join(work, 'date.txt');
      await writeFile(dateFile, payload.eventDate.toUpperCase(), 'utf8');
    }
    const publisher = payload.sourcePublisher || hostLabel(payload.sourceUrl);
    await writeFile(sourceFile, `Source: ${wrap(publisher, 52, 1, 40)}`, 'utf8');
    let hookFile = null;
    if (hasHook) {
      hookFile = join(work, 'hook.txt');
      await writeFile(hookFile, wrap(payload.hookText, 16, 2, 48), 'utf8');
    }

    // Background: cover 1080x1920.
    const inputs = [];
    const vf = [];
    if (mode === 'image') {
      inputs.push('-i', input);
      vf.push(
        `[0:v]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,` +
        `zoompan=z='1+0.10*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=30,` +
        `setsar=1[bg]`
      );
    } else if (mode === 'wan-video') {
      const loops = Math.max(1, Math.ceil(dur / Math.max(probedDuration, 0.5)));
      inputs.push('-stream_loop', String(loops - 1), '-i', input);
      vf.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[bg]`);
    } else {
      inputs.push('-i', input);
      vf.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[bg]`);
    }

    const scrimTop = 1040;
    const scrimH = H - scrimTop;
    inputs.push('-f', 'lavfi', '-i', `color=s=${W}x${scrimH}:r=30:d=${dur.toFixed(2)}:color=black`);
    vf.push(`[1:v]format=rgba,geq=r=8:g=14:b=26:a='if(lt(Y,180),(Y/180)*200,200-((Y-180)/(H-180))*70)'[scrim]`);
    const topH = 320;
    inputs.push('-f', 'lavfi', '-i', `color=s=${W}x${topH}:r=30:d=${dur.toFixed(2)}:color=black`);
    vf.push(`[2:v]format=rgba,geq=r=8:g=14:b=26:a='130*(1-Y/H)'[topscrim]`);
    if (musicFile) inputs.push('-stream_loop', '-1', '-i', musicFile);
    const musicIdx = musicFile ? 3 : -1;
    let voiceIdx = -1;
    if (voiceFile) { inputs.push('-i', voiceFile); voiceIdx = musicFile ? 4 : 3; }
    vf.push(`[bg][topscrim]overlay=0:0:format=auto[bg2]`);
    vf.push(`[bg2][scrim]overlay=0:${scrimTop}:format=auto[base]`);

    const dt = [];
    const F = `fontfile=${FONT}`;
    const brand = String(payload.brandName || 'NEWS PULSE').replace(/[^A-Za-z0-9 ]/g, '').trim() || 'NEWS PULSE';
    dt.push(`drawbox=x=60:y=234:w=22:h=22:color=0xE63946:t=fill`);
    dt.push(`drawtext=${F}:text='${brand}':fontcolor=white:fontsize=36:x=98:y=230:alpha=0.95`);
    if (dateFile) {
      dt.push(`drawtext=${F}:textfile=${dateFile}:fontcolor=white:fontsize=30:x=60:y=278:alpha=0.9`);
    }
    dt.push(`drawtext=${F}:text='AI-GENERATED VISUALS':fontcolor=0xB9C2D0:fontsize=26:x=w-text_w-60:y=240:alpha=0.85`);
    if (hookFile) {
      dt.push(
        `drawtext=${F}:textfile=${hookFile}:fontcolor=white:fontsize=104:line_spacing=10:` +
        `x=(w-text_w)/2:y=(h-text_h)/2-120:alpha='${envelope(0.1, 2.2, 0.4)}'`
      );
    }
    dt.push(`drawbox=x=60:y=1124:w=132:h=8:color=0xE63946:t=fill`);
    dt.push(
      `drawtext=${F}:textfile=${headlineFile}:fontcolor=white:fontsize=58:line_spacing=12:` +
      `x=60:y=1160:alpha='${holdIn(storyStart)}'`
    );
    cards.forEach((card, i) => {
      const [s, e] = windows[i];
      dt.push(
        `drawtext=${F}:textfile=${cardFiles[i]}:fontcolor=0xE9EEF7:fontsize=42:line_spacing=10:` +
        `x=60:y=1440:alpha='${envelope(s, e)}'`
      );
    });
    dt.push(
      `drawtext=${F}:textfile=${sourceFile}:fontcolor=0x9AA5B8:fontsize=28:` +
      `x=60:y=1640:alpha='${holdIn(1.0, 1.0)}'`
    );
    vf.push(`[base]${dt.join(',')},format=yuv420p[out]`);

    // Audio: voiceover is primary; music bed ducked underneath; native video
    // audio kept low when present. Voice is padded to the full duration so
    // the mix never ends early.
    const mixLabels = [];
    if (voiceFile) {
      vf.push(`[${voiceIdx}:a]volume=1.0,apad=whole_dur=${dur.toFixed(2)}[v_voice]`);
      mixLabels.push('[v_voice]');
    }
    if (musicFile) {
      vf.push(`[${musicIdx}:a]volume=${voiceFile ? 0.07 : 0.2}[v_mus]`);
      mixLabels.push('[v_mus]');
    }
    if (mode === 'video' && hasAudio) {
      vf.push(`[0:a:0]volume=${voiceFile ? 0.25 : 1.0}[v_src]`);
      mixLabels.push('[v_src]');
    }
    const hasMixedAudio = mixLabels.length > 0;
    if (hasMixedAudio) {
      vf.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[aout]`);
    }

    const ffmpegArgs = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
      '-filter_complex', vf.join(';'), '-map', '[out]'];
    if (hasMixedAudio) {
      ffmpegArgs.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-shortest');
    } else {
      ffmpegArgs.push('-an');
    }
    if (mode !== 'video') ffmpegArgs.push('-t', dur.toFixed(2));
    ffmpegArgs.push('-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
    await run('ffmpeg', ffmpegArgs, { timeout: 240000 });

    // Cover frame: mid-reel, headline + caption + source visible.
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-ss', Math.min(4, Math.max(1, dur - 1)).toFixed(2),
      '-i', output, '-frames:v', '1', '-q:v', '4',
      join(outDir, 'cover.jpg'),
    ], { timeout: 60000 });

    // Validate output dimensions.
    const { stdout: vprobe } = await run('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', output,
    ], { timeout: 30000 });
    const vdata = JSON.parse(vprobe);
    const vs = vdata.streams.find((s) => s.codec_type === 'video');
    if (!vs || vs.width !== 1080 || vs.height !== 1920) {
      throw new Error('Output validation failed: not 1080x1920');
    }

    // Manifest for the n8n poll loop.
    const base = baseUrl.replace(/\/$/, '');
    const manifest = {
      request_id: requestId,
      status: 'ready',
      video_url: `${base}/reels/${requestId}/reel.mp4`,
      cover_url: `${base}/reels/${requestId}/cover.jpg`,
      duration_seconds: Math.round(dur),
      width: 1080,
      height: 1920,
      renderer_version: VERSION,
      voiceover: Boolean(voiceFile),
      created_at: new Date().toISOString(),
    };
    const reqDir = join(publicDir, 'requests');
    await mkdir(reqDir, { recursive: true });
    await writeFile(join(reqDir, `${requestId}.json`), JSON.stringify(manifest, null, 2));
    await writeFile(join(publicDir, '.nojekyll'), '');
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Render failed:', e.message);
  process.exit(1);
});
