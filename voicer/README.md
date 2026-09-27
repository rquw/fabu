# Choicer Voicer

Recreate iconic movie moments with your own voice. Watch a short clip, match the
character's timing and delivery as closely as possible, and see how your
performance compares.

Solo works fully offline-ish in the browser. Party mode needs this little server.

## what it does

- upload any movie clip (mp4, mov, webm, mkv). cuts are detected automatically
  and grouped into dubbable clips. you can join/split them on the timeline
- auto script: Whisper runs **in your browser** (transformers.js), no API key.
  first run downloads the model (~80 MB), then it's cached. every line is editable
- voice removal without AI: film dialogue sits dead center in the stereo mix, so
  the center gets cancelled and music/effects on the sides stay. mono files get
  the speech band notched out instead. or just mute everything
- karaoke-style script, live visualizer (the pale shape is the actor's voice,
  yours fills in over it), 3-2-1 countdown
- scoring like the original: 58% rhythm, 32% duration, 10% coverage, five judges
  hand out 0–5 stars
- party mode: room codes, everyone records at the same time, takes get played
  back one by one, judges + audience vote, podium at the end
- final videos render **on the device** (canvas + MediaRecorder, mp4 on
  Chrome/Edge/Safari, webm on Firefox). nothing gets uploaded for that

## run it locally

```bash
cd voicer
npm install
npm start
# open http://localhost:8080
```

The mic only works on `localhost` or HTTPS.

## put it online (Render, free)

1. Push this repo to GitHub (already done if you're reading this there).
2. Go to https://dashboard.render.com → **New** → **Blueprint**.
3. Pick the `fabu` repo. Render finds `render.yaml` in the root and sets up a
   web service called `choicer-voicer` with root dir `voicer`.
4. Click **Apply**. First deploy takes ~2 minutes.
5. Your game lives at `https://choicer-voicer.onrender.com` (or whatever name
   Render gives it). Send that link to friends. HTTPS is automatic, which the
   mic needs.

Doing it by hand instead of the blueprint: **New → Web Service**, repo `fabu`,
Root Directory `voicer`, Runtime Node, Build `npm install`, Start
`node server.js`, instance type Free.

Free tier notes:
- it falls asleep after 15 min without traffic. first visit after that takes
  ~30–60 s to wake up. that's normal
- uploaded videos live on temporary disk and get deleted when the room closes
  (15 min after everyone leaves) or when the server restarts
- `MAX_UPLOAD_MB` (default 800) caps the host upload size
- bandwidth: guests stream only the parts of the video they need (HTTP range
  requests), takes are ~50 KB opus each, rendering happens on each device

## how party mode works

```
host uploads video ──► server stores it temporarily (/tmp)
host's browser finds cuts + writes the script, sends clip list (tiny JSON)
guests stream the video from the server with range requests
every round:  loading → listen → record (everyone at once) → showtime → vote → results
takes (opus, ~50 KB) go up to the server, everyone downloads them for showtime
```

The server is ~500 lines of plain Node + `ws`, no database.

## files

- `server.js` rooms, uploads, range streaming, game state machine
- `public/js/analyze.js` audio decoding, voice envelopes, cut detection, clip grouping
- `public/js/asr.js`, `asr-worker.js` Whisper in a web worker
- `public/js/audio.js` voice remover, mic capture (AudioWorklet), sync
- `public/js/score.js` rhythm / duration / coverage + judges
- `public/js/stage.js` player, karaoke, visualizer, countdown
- `public/js/export.js` client-side video render
- `public/js/codec.js` opus packing for takes (WebCodecs, wav fallback)
- `public/js/studio.js` upload + clip editor
- `public/js/app.js` screens, solo + party flow

## tips

- headphones. without them your mic hears the clip and scores get worse
  (echo cancellation helps, it's on by default)
- if your dub plays back early/late, fix it in Settings → Sync offset.
  bluetooth headphones usually want −100 to −250 ms
- the auto script is best in English. set the language in Settings if it guesses wrong
