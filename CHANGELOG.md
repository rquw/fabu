# Changelog

## 1.2.5

**fabu works on a phone and an iPad now.**
It really did not before. The page could scroll sideways by eight pixels, which was enough to slide the whole app left and take the close button of whatever you had open off the edge of the screen, which is why the piano roll was a room with no door. Windows are proper sheets on a touch screen: pinned to the bottom, full width, with a grab bar, a close button you can actually hit, and a dimmed backdrop you tap to get out of. Nothing opens bigger than the screen any more.

**The piano roll got what it was missing.**
You can reach other octaves without a mouse wheel, which means you can reach them at all on a tablet: octave buttons in the toolbar, or drag the piano keys up and down. The keyboard lives in the piano roll now, next to the pattern it plays into, and recording on top of a pattern goes into that pattern instead of building a separate take on a new track. Notes appear as you press and lengthen while you hold.

**Automation you can see.**
A track can show its volume, filter or pan as a lane underneath it, at the same zoom as the song. Quiet at the start and loud at the end is a shape that rises. Click adds a point, drag moves it.

**The loop button looked like undo because it was using the undo icon.**
It has its own now.

**The letters on the on-screen keyboard match your actual keyboard.**
They were a fixed German row before, so they were wrong on QWERTY and very wrong on AZERTY. Which note each key plays never depended on this and has always worked on any layout.

**Saving asks for a name, not a folder.**
It goes in your fabu projects folder, and Save and exit tells you where it went and offers to open it. An existing name gets a number rather than being written over.

**Smaller things**
- fabu opens filling the screen the first time. Resize it and that sticks.
- Windows and Linux no longer get a File/Edit/View menu bar that does nothing.
- Closing the app closes it, instead of waiting on a round trip first.
- The greeting follows the clock. Six in the morning gets "Early music production?".
- Loops in the gallery can be listened to before you take them.
- Chord suggestions are gone.


**Your loops can go where other people will find them.**
There is a gallery now. Put a loop in it from the loop editor, browse by newest, most liked, or only people you follow, and add anything you hear straight into your own loops with the author's name still on it. Profiles carry a line about you and a colour. Following each other both ways makes you friends.

A shared loop is a recipe, not a recording: notes, an instrument name and a length, a few hundred bytes. That is why this can exist for free, and why nothing in it accepts audio. Reports are per person, three from different people takes a loop down on its own, and it can be put back.

**The piano roll suggests what comes next.**
Write a chord or two and it works out where they sit in the key, then offers the one that usually follows. Tab adds it, Shift+Tab picks a different option. It says "G major", not "V", because nobody should need theory to use it, and it can be turned off in Settings.

**fabu works on a phone.**
Not as a compromise: dragging patterns, the piano roll, the loop library and the mixer all work with a finger. Press and hold a loop to pick it up. The track list no longer eats the whole screen, the toolbar keeps every tool instead of quietly dropping them, and windows open as sheets along the bottom.

**Being removed from a room now sticks.**
Moderation used to key on the display name, which is typed in by the person being moderated, so a kick lasted as long as it took to pick a new one. It does not any more. If somebody clears their browser and comes back on the same connection, the host is told by name and gets a "let them in" button, in case it turns out to be somebody's brother on the same wifi.

**Humanize, and real automation curves.**
Nudge timing and loudness slightly so a part sounds played rather than programmed. Automation points can ease in and out instead of only running straight between each other.

## 1.2.4

**Paint effects across patterns.**
Hold shift and the effect cards turn green with a plus. Drag one across the timeline and it lands on every pattern you pass over, once each, so you can put reverb on a whole section in one stroke. Let go and start again to apply the same effect a second time.

**A pattern with effects on it now looks like one.**
A quiet gold edge you can pick out across the whole timeline, and a badge that names what is on it for a few seconds before shrinking back out of the way. The names stay on hover. When an effect lands there is a single sweep across the pattern, and then it leaves you alone.

**Exports cannot clip any more.**
Stack enough loops and the mix could push past what a sound file can hold, and the result was crackle on the loudest moments. There is a ceiling on the way out now. Quiet and normal projects are completely untouched by it; it only catches what would have broken.

**A loop for every instrument, and a jazz section.**
Every instrument in the list now has at least one loop, so you can hear what each one sounds like without writing anything. The jazz set is built to be stacked: swing ride, brush shuffle, walking bass, piano comping, trumpet and sax written as call and answer, vibes and horn stabs. All of it is in the same key as the rest, so anything layers with anything.

**Dragging feels like dragging.**
The card follows your cursor and swings from your hand instead of sitting frozen, patterns lean the way you are moving them, and letting go scatters the card into dust rather than blinking it out.

**A properly redone export window.**
It tells you what you are exporting and how big each format will be, with the audio formats separated from MIDI and separate tracks, which are a different kind of thing entirely.

**MIDI files come out with useful track names.**
A track called Instrument 2 tells another program nothing, so if you have not named a track, the name of its longest pattern is used, or failing that the instrument.

**Smaller things**
- Settings opens from the home screen properly instead of behind it, and no longer suggests that per song options apply to everything.
- The time signature moved onto the bar counter in the top bar, where it belongs. Click it.
- Removed the Downlifter and Sax Stabs presets.
- Sub Bass actually uses the 808 now, House Bass sits between the kicks instead of on top of them, and hi-hats have accents rather than being flat.
- The Acoustic Groove loop could come out completely silent. That, and one instrument going quiet for a whole session after a hiccup while loading, are both fixed.
- The macOS drag icon no longer flies in from the corner when you pick up a loop.

## 1.2.3

**Everyone in a room needs the same version now.**
The project format and the way rooms sync both change between releases, and a mismatched player did not fail cleanly, it quietly broke things. So joining now checks the version, and if it does not match you are told exactly what you need and where to get it. If you are ahead of the host it says so and points you at the older build, because that one is not your fault. Update together with whoever you jam with.

**Trumpet, flute, saxophone and a real organ.**
Actual recordings, not synths pretending. The organ replaces the old synthesised one, so projects using it just sound better with nothing to change. The trumpet records slightly flat and the saxophone slightly sharp, the way real instruments do, and fabu now corrects for that so they play in tune with everything else.

The old "Keys" is gone. It was a synthesised piano standing next to a real recorded grand, and there was no reason to keep both. Projects that used it move to the Grand Piano on their own.

**Export MIDI.**
The notes, not the sound, so you can take a song into another program. Tempo, time signature, every track and the sustain pedal all come across.

**Time signature moved to the bar counter.**
It sits with the bar and beat display in the top bar, where it belongs, and clicking it changes it. It was in Settings before, which made a property of the song look like a setting for the whole app. Settings is now split into what belongs to the song and what belongs to fabu, and it opens from the home screen too.

**Rooms are safer.**
The server now refuses messages aimed at a room the sender never joined. Before this, anyone who knew a room code could push things into it without being in it, which meant none of the host's controls applied to them. It also limits how fast and how much anyone can send. This one is already live and protects you whether or not you update.

**Big songs and long files stopped breaking.**
Opening the note editor on a long piece could come up blank or full of broken boxes, and zooming into a busy project could leave patterns empty. Both were the same cause and both are fixed.

**Exports could come out silent.**
If you opened a project and exported straight away, before the instrument sounds had finished loading, you got a file with nothing in it. Every export now waits for them. A related problem could leave one instrument silent for a whole session after a single hiccup while loading, with nothing on screen to say so.

**Opening a project from a newer version warns you first.**
Saving over it would quietly throw away anything the newer version added, so now you get the choice.

## 1.2.2

**Windows: please download this one from the website.**
Updating from inside the app is broken on Windows and has been for a while. It half installs, gives up, and leaves you with no fabu at all. That is fixed, but the fix lives in this version, so it cannot rescue the update into it. Grab the installer from the site this once and in app updates will work normally from here on. Sorry about that one.

**Drop a MIDI file onto the timeline.**
It becomes real patterns you can open and edit, not a locked block of audio. Every part of the file gets its own lane, split wherever the file changes instrument, so a piece that goes piano, then trumpet, then violin arrives as three lanes you can move around separately. Drum parts land on their own lane too. Each lane starts on the closest instrument fabu has, or the grand piano when nothing is close.

Drop one into an empty project and the project reshapes itself to fit: tempo, time signature and the file's name. Drop one into a project you are already working on and it asks before touching your tempo.

**Sustain pedal.**
Hold Shift while the keyboard is open, click the Sustain button, or use a real pedal on a MIDI keyboard. Notes keep ringing after you let go, like a real piano. It records as you play it, it comes through in exported files, and you can draw it by hand in the piano roll on the strip under the bar numbers. MIDI files bring their pedal with them, which is most of what makes a piano piece sound like one.

**Time signatures.**
3/4, 6/8 and the rest, in Settings. The ruler, the bar numbers, the metronome accent and where patterns snap all follow it.

**New projects start empty.**
No lanes to clear out first. Add what you want with the Instrument and Audio buttons. The walkthrough for new users starts there now.

**Windows remember their size and place.**
The main window and every panel inside it. Size the mixer how you like it once and it stays that way.

**Big songs stopped breaking.**
Opening the piano roll on a long piece could come up blank or full of broken boxes, and zooming into a busy project could leave clips empty. Both were the same thing: the app was asking for a drawing surface far larger than the browser allows, and being handed nothing. It now draws only the part you can see. A four thousand note part redraws in about a millisecond.

**Jam rooms hold together.**
The server sleeps when nobody is using it and can take a few seconds to wake. The app used to give up before that and the room would just die. Now it keeps trying quietly and puts you back without anyone seeing you leave. Lose your wifi and get it back and you land in the same room.

**When something goes wrong it says so.**
Every way a room can break now has a real sentence attached. "Servers went down." "You are offline." "Host disconnected." No more guessing whether it is you, your internet or the app. If it can be retried there is a button, and your work is saved before anything else happens.

**Rooms use a fraction of the traffic.**
Project changes are compressed, cursors slow down as a room fills and switch off past forty people, and the presence heartbeat eases off too. A hundred people in one room went from impossible to tested and working.

**The host leaving is no longer a game show.**
The spinning name picker is gone. If the host drops it waits a moment in case they are reconnecting, then hands over quietly and tells you who has it.

**Smaller things**
- Click the BPM number and just type. It still drags if you drag it.
- fabu now mentions the L key when you look like you want it: after you mark a section, after you replay the same spot a few times, or when a repeat is holding the playhead in. Marking a section no longer switches repeat on by itself.
- Dragging a MIDI file in says MIDI instead of calling it an audio file.
- Track colours. Click the dot next to a track's name.
- Reconnecting no longer puts a second copy of you in the player list wearing your own crown.
- The 808 no longer clicks at the start of a note.
- Settings opens again. A mistake in this release's own time signature work had broken it.
- The walkthrough no longer appears over the home screen, no longer repeats a step, and its "change the sound" step works again after quietly pointing at a control that no longer existed.

## 1.2.1
- "Restart in 1 minute" no longer traps you. It now counts down in a small bar in the corner so you can keep working and save, restart early, or cancel it.
- Section markers work again. Naming one opened a dialog the desktop app cannot show, so right-clicking the ruler often did nothing at all.
- Right-clicking the ruler no longer grabs and drags the repeat region. It opens a proper menu: add or remove a marker, turn repeat on or off, and clear it.
- You can clear the repeat region now.
- The piano roll opens where the instrument actually lives, so a bass starts in the low octaves instead of the high ones where it sounds wrong.
- 808 Bass keeps its character higher up the keyboard instead of turning into a whistle.
- The shortcut list is up to date again, including repeat, grouping, scrubbing, automation and dragging a clip out to a new track.

## 1.2.0
- Multiplayer security: the host now checks every change that comes in and undoes anything that breaks the room rules. Before this, the rules only ran on the other person's computer, so a modified app could ignore them. Someone who is removed is now really removed, even if their app pretends otherwise.
- Accounts: the signed-in name updates properly. It no longer keeps showing the old username after logging out, logging in as someone else, or having the name changed.
- Clearer sign-in messages: "Username already taken", "Wrong password", and "No account called X. Want to create one?" with a button that takes you straight to registering.
- Usernames are checked against a profanity list.

## 1.1.9
- Five new instruments: Upright Piano, Glockenspiel and Harp (real recordings), plus an 808 Bass and a Warm Pad. The instrument menu now has a Strings group too.
- Loop a section: shift-drag the ruler (or press L) to repeat part of your song while you work on it.
- Section markers: right-click the ruler to name a part (Intro, Drop, Chorus), right-click it again to remove it.
- Export stems: one audio file per track, so you can take the parts into another program.
- Exports now sound like what you hear. They were being squashed harder than the app played them back.
- The mixer shows one track at a time with room to breathe, plus a track list to switch, instead of a wall of narrow strips.
- Much faster with big songs: the timeline only draws what is on screen, so a long project stays smooth.

## 1.1.8
- Multiplayer: a wrong room code now actually says "Invalid Code" instead of waiting forever.
- Change history: hosts can see who added or removed patterns, sounds and tracks, and who joined or left.
- Getting your custom sounds turned off now tells you so, and for how long.
- "Manually approve custom audio files" works on its own, without needing custom sounds allowed first.
- Manage people: the search box no longer loses focus after every letter.
- Removed the follow-a-player feature and the "allow joining after start" rule.
- Clearer wording on the new-code button.
- Recent projects: the play button turns into a stop button while that project plays, and stops it when clicked.
- The top bar no longer scrambles when the window is not fullscreen.
- Completed and polished the German translation.

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
