# fabu

A music program. Piano roll, instruments, effects, a mixer, and you can make
stuff with other people at the same time.

https://rquw.github.io/fabu/

![fabu](docs/icon.png)

## what it does

- piano roll, synth instruments, a drum kit, and you can build your own
  instrument out of any audio file
- per clip effects: gain, pitch, speed, drive, bitcrush, filter, fades
- 3 band EQ, pan, mute, solo, automation lanes
- record the mic, or record notes live off your keyboard
- multiplayer. same project at the same time, with cursors and host controls
- saves as .fab, exports wav / mp3 / ogg

## running it

```bash
npm install
npm start
```

## building

```bash
npm run dist        # whatever os youre on
npm run dist:mac    # universal dmg
npm run dist:win    # windows exe
```

Pushing a version tag builds both and puts them on the releases page. The app
updates itself from there.

## relay

Multiplayer goes through a small websocket relay, it lives in `relay/`. Any
free node host does the job, mine is on Render.

## license

MIT, see LICENSE.
