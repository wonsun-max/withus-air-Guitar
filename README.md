# WITHUS Air Guitar — Play Guitar with Your Bare Hands

Point a webcam at your hands and play real guitar chords in the air. No instrument, no touch — just **MediaPipe hand tracking** mapped to **soundfont-based chord playback** in the browser.

## Why I built it

I'm a mentor in our school's "Integration of IT and Performing Arts" course, and I kept asking one question: *what can AI add to a live performance that a human can't do alone?* This project is one answer — it turns gesture into music, letting a performer "play" guitar chords mid-choreography without holding an instrument. I used it in our music video / stage production work at Manila Hankuk Academy.

## How it works

1. **Hand tracking** — `@mediapipe/tasks-vision` detects hand landmarks from the webcam in real time
2. **Gesture mapping** — hand position and strumming motion are interpreted as chord selection + strum events
3. **Sound synthesis** — chords are played through `soundfont-player` / `Tone.js` / `smplr`, so it sounds like an actual guitar, not beeps

The interesting engineering problem was **latency and stability**: raw landmark data is jittery, and a strum gesture must trigger sound immediately or the illusion breaks. Smoothing the signal without adding perceptible delay took most of the iteration time.

## Tech stack

React 19 · TypeScript · Vite · MediaPipe Tasks Vision · Tone.js / soundfont-player · Tailwind CSS

## Context

Part of my Grade 12 Performing Arts activities at Manila Hankuk Academy — this is the "program applying MediaPipe, an AI-based motion recognition technology, creatively incorporating guitar chord sounds into musical performance" described in my school records. A sub-project of my WITHUS ecosystem.
