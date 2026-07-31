# Changelog

## 1.1.7
- Scrubbing: drag the playhead while stopped to hear what's under it. It holds the notes like keys instead of re-triggering them. Turn it on or off in Settings.
- Editing while playing: change a long note's clip settings (gain, transpose, drive, crush, filter, effects) and it applies to the note that's already sounding, not just the next one. Switching a pattern's instrument applies live too, with no stutter or "simulated" re-attack.
- Automate more: gain, transpose, drive, crush and filter now have keyframe lanes alongside volume, EQ and pan.
- Automate effects: keyframe a dropped effect's parameters over time (tremolo depth and rate, echo, reverb, filters, wobble, widen). There's an "A" button on each effect and on the clip settings, and it renders into your exported song.
- Automate pitch and speed on audio clips and groups, sample-accurately: the block stretches to the real length, the waveform bends with the curve, and seeking lands exactly where it sounds.
- Piano roll: smooth, precise up/down scrolling instead of the old laggy 2-note jumps, and it grows to fill the window when you make it taller.
- Patterns now have a Speed control in the clip settings, so you can play a pattern faster or slower, plus a fine Pitch (cents) control.
- Clip settings redesigned: every value is a directly editable number field (no sliders) with generous ranges — type any gain, transpose, speed or filter you want. No more hard caps boxing in your sound.
- Groups are flattened into a real audio clip now: correct waveform, pitch/speed/effects all work, and you can drop effects straight onto them. Ungroup brings the original clips back.
- Microphone recording is more reliable (a proper codec, so takes no longer come back silent), and it no longer drops playback into tinny "phone call" quality while the mic is on.
- Grand Piano and Vibraphone: longer piano samples for slow, sustained songs, and the vibraphone no longer turns into a weird tone above C4.
- Multiplayer, moderation for streamers:
  - Room rules to allow or block microphone recording and custom audio files for everyone.
  - Manually approve custom sounds: review a guest's sound with a waveform player (play, scrub, volume) before it is added.
  - Deny a sound and optionally ban that person from adding sounds for a set time.
  - Manage people: per-person mic and sound permissions, and lift bans, including people who have already left.
  - Kick everyone except one person, or shift-select several and kick the rest.
  - Room code: click to reveal, again to copy, again to hide. Cycle the code to kill a leaked one while keeping everyone who is already in.
  - Clearer messages ("Invalid Code", "Connecting…"), "Make music with other people", and the code no longer shows while a room is being created.
- Labeled toolbar: Keys, Mixer, Effects, Loops, Jam and Settings now show their names, not just icons.
- The track list scrolls far enough to reach the add-instrument and add-audio buttons, and New project sits top-left on the home screen.
- Updates: constant checking, a clearer banner, a "Restart now / in 1 minute" prompt, a Check for updates button, and it tells you when you are already up to date.
- Saving a project that already has a file writes straight to it, no dialog.

## 1.1.6
- MIDI keyboards: plug one in and play (and record) any instrument track with it. Turn it on or off in Settings.
- Sidechain "pump": a per-track slider in the mixer that ducks the track on every beat for that classic pumping groove.
- Two real recorded instruments: a Grand Piano and a Vibraphone (genuine samples, not synth), in the instrument menu.
- Compound clips: select clips across tracks, right-click Group into one (or Cmd G). They become a single block on a new track, non-destructive, ungroup any time (Cmd Shift G).
- Drum patterns now open as a clean drum-lane editor: only the drums that actually play, each on a clearly labeled row. No more silent mystery keys.
- Redesigned home menu: clear labeled cards so you can find everything at a glance.
- Clips no longer overlap: drag one past another and it snaps to the nearest free spot; recording over something drops the take on its own lane.
- Piano roll extends as you scroll, so you can write past the end of a pattern. It also has a playhead you can drag to scrub.
- Quantize can line up the selected notes or all of them. Swing is now per-track, in the mixer.
- Floating windows are resizable from the edges and corner.
- The app now asks to save unsaved work before you go home or close it.
- Cleaner scrollbars, and a bunch of layout fixes.

## 1.1.5
- Real drums: a new Acoustic Kit made from genuine recorded samples (kick, snare, hats, clap, tom). Pick it on any drum track and program beats with real hits, or grab the new Acoustic loops from the Loops browser.
- Piano roll gained a lot: choose a Key and scale to shade the notes that fit, a Chord button that drops full chords, snap-to-key, a velocity lane to shape how loud notes are, and a playhead you can see and drag to scrub.
- Quantize now lets you line up Selected notes or All of them.
- Swing is per-track now, in the mixer, so you can make the drums groove while the bass stays straight.
- Cleaner look: lighter scrollbars, loop names no longer wrap to two lines, home and top-bar buttons no longer get cut off or squished on smaller windows.
- Clearer EQ: gridlines, frequency and dB readouts, a live value while you drag, and double-click a band to reset.
- Dropping a loop or audio file shows a preview of where it lands. Windows dim slightly while you drag them.
- Removed some synth sound effects that did not sound good. BPM dragging works reliably on macOS now.

## 1.1.4
- First-project tutorial: after you add your first pattern, a short skippable walkthrough points at double-click-to-edit, mute and solo, switching instruments, adding layers, the loops browser and playing together. Press Esc or Skip anytime.
- Sound effects in the Loops browser: risers, reverse cymbals, impact hits, laser zaps, a skill-point ding, downlifters and whooshes to fill the silence.
- Loops browser is scrollable, has a clearer icon, and tells you to "drag it anywhere" when you click a loop. Renamed a few loops to plainer names.
- Drag-and-drop previews: dragging a loop or audio file now shows a translucent block where it will land, how long it is and its waveform.
- Mixer EQ redesigned: pick a track and shape it with one large, clear equalizer instead of a cramped strip per track.
- Previewing into the middle of a long note no longer re-strikes it, it eases in like it was already playing.
- Windows go slightly see-through while you drag them, and the close X in the corner is easier to spot.

## 1.1.3
- New Loops browser: drag in ready-made drum beats, basslines and melodic loops from the toolbar. They're editable patterns, so double-click to make them your own.

## 1.1.2
- Playback fixes: notes no longer cut out when something loud hits, long notes play when you drop the playhead into them, and edits (delete a clip, add an effect) apply live while the song plays — for you and everyone in the room.
- Much lighter on the CPU: gentler limiting, smarter voice handling, and the playhead no longer stutters or freezes.
- Recording overhaul: the mic is captured raw (no more noise-cancelling artifacts), you can pick your input device in Settings, and the record button is now a microphone so it's clear what it does.
- Count-in is off by default now, small and out of the way, and you can cancel it (Esc or click it).
- Multiplayer: see each other's cursors everywhere (not just the timeline), click a person to follow their exact screen (Figma-style, with "Following X" / "X is following you"), and open dropdowns/menus no longer snap shut when someone edits.
- Creating a room no longer shows a stale "create room" panel while it connects.
- More effects: Low cut, Tremolo, Wobble, Widen.
- New/empty projects show a "double-click to add a pattern" nudge.
- Small stuff: BPM drag really locks the cursor now, group note-resize in the piano roll, listen to a recent project from the home screen without opening it, Register is the default account tab.

## 1.1.1
- Select many at once: drag a box on the timeline or in the piano roll, shift-click to add. Move, resize, delete and duplicate work on the whole selection.
- Effects you can drag onto clips: Reverb, Echo, Dampen, Drive, Crush (new Effects window in the toolbar). Right-click a clip → "Edit effects" to tweak or remove them.
- Instrument clips get Drive, Crush and Filter too, and effect edits apply live while the song plays.
- The mixer EQ is visual now: drag the three points to shape the curve.
- New instruments: E-Piano, Organ, Strings.
- Metronome: real tick sound options — long-press the metronome button to pick one.
- Smoother on weak computers: fabu limits voices under load, and Settings has a "Reduce CPU load" switch.
- Small stuff: BPM dragging locks the cursor, the add-track buttons sit under the track list now, and recent projects have listen/edit halves.

## 1.1.0
- Updating actually works now, for real. Windows installs the update properly instead of failing, and Mac swaps itself in place. This is the last version you have to install by hand — everything after updates itself.
- Mac: you only see the security prompt on the very first open (right-click → Open). After that, updates are seamless and prompt-free.
- The home screen background gently drifts now.
- The on-screen keyboard has a close button, and picking an instrument no longer stops the keys from playing.

## 1.0.9
- You can now see your version (home screen corner + Settings) and check for updates yourself with a button in Settings.

## 1.0.8
- Multiplayer: if your connection drops, fabu reconnects by itself and slips you back into the room, no re-approval, no "left/joined" spam.
- Multiplayer: late-arriving old states can no longer roll back newer edits.
- Multiplayer: incoming changes wait while you're typing a name so your text doesn't get wiped.
- Multiplayer: a note when the server is waking up, and one bad message can no longer crash the session.
- Updates: after an update, fabu greets you with "Updated to fabu vX.Y.Z". It also saves your project right before restarting, retries a failed download once, and cleans up old update files.

## 1.0.7
- One-click updates. When a new version is out, click Update and fabu downloads it, verifies it, and restarts itself on the new version. No browser, no installer files to manage.

## 1.0.6
- Fixed metronome sound bug.

## 1.0.5
- Updating is reliable now. When there's a new version, fabu shows an "Update available" notice and opens the download page — you grab the installer and run it. No more failed background updates that could remove the app (this affected both Windows and Mac).

## 1.0.4
- Fixed bugs.

## 1.0.3
- Fixed Windows auto-update. Updates now install silently and reliably instead of failing and leaving the app uninstalled. (Switched to a one-click installer.)

## 1.0.2
- Fixed a lot of bugs in multiplayer: no more lag storms, edits and sliders no longer jump back, joining no longer wipes the project, and false "host left" / two-hosts is fixed.
- Multiplayer cursors are smooth now, everyone has their own colour, and you can see other players' playheads.
- Space always plays/pauses, even with a window or menu focused.
- You can scroll the track list when there are many instruments.
- Instrument clips now have Gain and Transpose in the clip menu.
- Little easter egg: hover the fabu logo on the home screen.

## 1.0.1
- Added an account management page (change password, delete account) in the app and on the website.
- Fixed the unstyled username field in the login box.

## 1.0.0
- First release: piano roll, instruments, drum kit, effects, mixer, recording, WAV/MP3/OGG export, live multiplayer, macOS + Windows installers, and the in-browser version.
