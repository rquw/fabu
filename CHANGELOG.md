# Changelog

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
