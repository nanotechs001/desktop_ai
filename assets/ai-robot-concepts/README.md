# Floating AI Robot — visual exploration v1

Generated with the built-in image generation workflow on 2026-10-17.

## Files

- `robot-concept-exploration-v1.png` — eight possible character directions on a 4 × 2 presentation board.
- `halo-orb-core-states-v1.png` — transparent 4-column × 6-row atlas for the selected halo-orb direction.
- `halo-orb-interaction-states-v1.png` — transparent 4-column × 3-row extended state board.
- `animation-strips-v1/` — six separate eight-frame animation sheets for the selected halo-orb design.
- `animation-strips-v1/turn-to-user.png` — one-shot transition from three-quarter taskbar pose to direct eye contact.
- `animation-strips-v1/facing-user.png` — looping front-facing attentive pose for an open chat.
- `animation-strips-v1/dragging.png` — looping suspended pose while the user drags the widget.
- `animation-strips-v1/drop-landing.png` — one-shot fall, squash, rebound and settle after release.
- `animation-strips-v1/appearing.png` — one-shot particle materialization when a widget is spawned or shown.
- `animation-strips-v1/disappearing.png` — one-shot particle dematerialization when a widget is hidden or removed.
- `animation-strips-v1/frames/` — sliced transparent PNG frames normalized to a fixed square canvas.
- `animation-strips-v1/previews/` — looping GIF and transparent animated WebP previews.

All images are 1536 × 1024. The two halo-orb sheets are RGBA PNGs with alpha transparency.

## Core atlas map

Each row contains four animation keyframes, read left to right.

1. Idle — soft hover, breathing glow
2. Thinking — orbiting light nodes, attentive eyes
3. Talking — face waveform pulses
4. Sleeping — tilted body, closed eyes, dimmed halo
5. Searching — focused eyes, scan ring and target
6. Working — orderly data particles and faster halo motion

## Extended state map

Read left to right, top to bottom:

1. Listening
2. Wake-up
3. Confirmed / success
4. Curious / question
5. Gentle error
6. Celebration
7. Microphone muted / privacy
8. Notification
9. Charging / restoring energy
10. Offline / low power
11. Minimized / compact
12. Update complete

## Character language

- **Face:** emotion and conversational timing
- **Halo:** activity level and system state
- **Orbiting bead:** attention, notifications, and progress
- **Cyan:** listening, speaking, searching, normal operation
- **Amber:** attention, transitions, and notifications
- **Coral:** warnings and recoverable errors only

These are concept/keyframe sheets, not yet a mathematically aligned shipping atlas. Before implementation, redraw or normalize the selected frames to a fixed cell size, consistent pivot, and repeatable loop timing.

## Animation strip timing

- Idle: 140 ms per frame
- Thinking: 140 ms per frame
- Talking: 90 ms per frame
- Sleeping: 180 ms per frame
- Searching: 110 ms per frame
- Working: 100 ms per frame
- Turn to user: 90 ms per frame, play once when the chat opens
- Facing user: 140 ms per frame, loop while the chat is open and waiting/listening
- Dragging: 120 ms per frame, loop only during an active drag
- Drop and land: 90 ms per frame, play once after drag release
- Appearing: 85 ms per frame, play once when shown
- Disappearing: 85 ms per frame, play once before hiding

Run `python tools/package_robot_sprites.py` from the project root to regenerate the sliced frames and previews from the twelve master sheets.

## 30 FPS v2 animations

The original eight-frame sheets and keyframes are preserved as source artwork. A smoother application-ready set is available under:

- `animation-strips-v1/frames-30fps/<state>/` — motion-interpolated transparent PNG sequences
- `animation-strips-v1/previews-30fps/<state>.webp` — transparent 30 FPS previews
- `animation-strips-v1/animation-30fps-manifest.json` — frame counts, durations, looping flags and asset patterns

All 12 states run at 30 FPS while retaining their original overall pacing. Looping flags are explicit in the manifest; appearing, disappearing, drop-landing and turn-to-user are one-shot sequences.

Run `python tools/build_30fps_animations.py` after packaging the eight keyframes to regenerate the v2 assets. The builder uses bidirectional optical-flow interpolation on premultiplied RGBA frames to retain transparent edges.
