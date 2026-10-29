import React, { useRef, useState, useEffect, useCallback } from 'react';

// ─── BASE URL — matches SettingsView pattern ──────────────────────────────────
import { BASE } from '../lib/base';

// ─── Stable pseudo-random bar heights, seeded per fileId ─────────────────────
// Decorative — real amplitude data isn't available for TTS.
// We generate once per fileId and cache so heights don't jump on re-render.
const _barCache = new Map<string, number[]>();
const BAR_COUNT = 48;

function getBars(seed: string): number[] {
  if (_barCache.has(seed)) return _barCache.get(seed)!;
  // Simple LCG seeded from string char codes
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    // Height 4–18px, biased toward center (more natural waveform shape)
    const raw = (s >>> 16) / 65535; // 0..1
    // Bell-ish curve: emphasize mid-bars
    const centre = Math.abs((i / (BAR_COUNT - 1)) - 0.5) * 2; // 0 at middle, 1 at edges
    const h = 4 + Math.round((1 - centre * 0.55) * raw * 14);
    bars.push(h);
  }
  _barCache.set(seed, bars);
  return bars;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  fileId: string;
  filename: string;
}

export function HearthAudioPlayer({ fileId, filename }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = getBars(fileId);
  const src = `${BASE}/api/files/${fileId}`;
  const progress = duration > 0 ? current / duration : 0;
  const playheadBar = Math.round(progress * (BAR_COUNT - 1));

  // Sync audio events
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    function onTime() { setCurrent(el!.currentTime); }
    function onMeta() { setDuration(el!.duration); }
    function onEnded() { setPlaying(false); setCurrent(0); }
    function onPlay() { setPlaying(true); }
    function onPause() { setPlaying(false); }

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('ended', onEnded);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);

    // If metadata already loaded (cached)
    if (el.duration && isFinite(el.duration)) setDuration(el.duration);

    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => {/* autoplay blocked */});
    }
  }, [playing]);

  function handleScrub(e: React.MouseEvent<HTMLDivElement>) {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrent(ratio * duration);
  }

  return (
    <div className="hap-shell">
      {/* Hidden audio element */}
      <audio ref={audioRef} src={src} preload="metadata" aria-hidden="true" />

      {/* Play/pause button */}
      <button
        className={`hap-play${playing ? ' playing' : ''}`}
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        type="button"
      >
        {playing ? (
          /* Pause bars */
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="5" y="4" width="4" height="16" rx="1" />
            <rect x="15" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          /* Play triangle */
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5,3 19,12 5,21" />
          </svg>
        )}
      </button>

      {/* Waveform scrubber */}
      <div
        className="hap-wave"
        role="slider"
        aria-label="Audio position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        onClick={handleScrub}
        onKeyDown={(e) => {
          const el = audioRef.current;
          if (!el || !duration) return;
          if (e.key === 'ArrowRight') { el.currentTime = Math.min(duration, el.currentTime + 5); }
          if (e.key === 'ArrowLeft') { el.currentTime = Math.max(0, el.currentTime - 5); }
        }}
      >
        {bars.map((h, i) => (
          <span
            key={i}
            className={`hap-bar${i <= playheadBar ? ' played' : ''}`}
            style={{ height: `${h}px` }}
          />
        ))}
      </div>

      {/* Duration readout */}
      <span className="hap-time">
        {formatDuration(current)} / {formatDuration(duration)}
      </span>

      {/* Filename label */}
      <span className="hap-filename">{filename}</span>

      <style>{`
        /* ─── HearthAudioPlayer ─── */
        .hap-shell {
          display: grid;
          grid-template-columns: 1.75rem 1fr auto;
          grid-template-rows: auto auto;
          align-items: center;
          column-gap: 0.5rem;
          row-gap: 0.25rem;
          background: rgba(201, 168, 124, 0.055);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.625rem;
          padding: 0.5rem 0.625rem;
          max-width: 22rem;
          user-select: none;
        }

        /* Play/pause — circular amber ghost button */
        .hap-play {
          grid-row: 1;
          grid-column: 1;
          width: 1.75rem;
          height: 1.75rem;
          display: grid;
          place-items: center;
          border-radius: 50%;
          border: none;
          background: rgba(201, 168, 124, 0.12);
          color: var(--amber, #c9a87c);
          cursor: pointer;
          flex-shrink: 0;
          transition:
            background 150ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            transform 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .hap-play:hover {
          background: rgba(201, 168, 124, 0.20);
        }
        .hap-play:active {
          transform: scale(0.92);
          background: rgba(201, 168, 124, 0.26);
        }
        .hap-play.playing {
          background: rgba(201, 168, 124, 0.18);
        }

        /* Waveform scrubber */
        .hap-wave {
          grid-row: 1;
          grid-column: 2;
          display: flex;
          align-items: center;
          gap: 2px;
          height: 20px;
          cursor: pointer;
          outline: none;
          border-radius: 2px;
        }
        .hap-wave:focus-visible {
          box-shadow: 0 0 0 1px rgba(201, 168, 124, 0.35);
        }

        /* Individual bars */
        .hap-bar {
          display: block;
          width: 2px;
          border-radius: 1px;
          flex-shrink: 0;
          background: rgba(201, 168, 124, 0.18);
          transition: background 80ms ease;
        }
        .hap-bar.played {
          background: var(--amber, #c9a87c);
        }

        /* Duration — mono, small */
        .hap-time {
          grid-row: 1;
          grid-column: 3;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          white-space: nowrap;
          letter-spacing: 0.02em;
          font-variant-numeric: tabular-nums;
          align-self: center;
        }

        /* Filename — below, spans all columns */
        .hap-filename {
          grid-row: 2;
          grid-column: 1 / -1;
          font-size: 0.5625rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          color: var(--text-muted, #6a6258);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0.75;
          padding-left: 0.125rem;
        }

        @media (max-width: 768px) {
          .hap-shell { max-width: 100%; }
        }
      `}</style>
    </div>
  );
}
