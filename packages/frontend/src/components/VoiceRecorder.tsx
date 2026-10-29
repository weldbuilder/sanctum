/**
 * VoiceRecorder — mic button for the Composer.
 *
 * Behaviour:
 *   Press/hold (or click) → start recording (MediaRecorder → WS chunks)
 *   Release/click again   → stop recording → backend transcribes
 *   While processing      → spinner; on complete → fires onTranscript
 *
 * Styled to the Hearth palette: ember amber when active, muted at rest.
 * Ported from the reference app's VoiceRecorder.svelte → React 19.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chat';

interface Props {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceRecorder({ onTranscript, disabled = false }: Props) {
  const send = useChatStore(s => s.send);
  const transcription = useChatStore(s => s.transcription);
  const clearTranscription = useChatStore(s => s.clearTranscription);

  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const processing = transcription.status === 'processing';
  const transcriptionError = transcription.status === 'error' ? transcription.error : null;

  // When transcription completes, fire callback and reset
  useEffect(() => {
    if (transcription.status === 'complete' && transcription.text) {
      onTranscript(transcription.text);
      clearTranscription();
    }
  }, [transcription.status, transcription.text, onTranscript, clearTranscription]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    setLocalError(null);
    clearTranscription();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4'; // Safari fallback

      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;

      send({ type: 'voice_start' });

      mr.ondataavailable = (event) => {
        if (event.data.size > 0) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(',')[1];
            if (base64) send({ type: 'voice_audio', data: base64 });
          };
          reader.readAsDataURL(event.data);
        }
      };

      mr.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        send({ type: 'voice_stop' });
      };

      mr.start(250);
      setRecording(true);
      setDuration(0);
      durationIntervalRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setLocalError('Microphone access denied');
      } else {
        setLocalError('Failed to access microphone');
      }
    }
  }, [send, clearTranscription]);

  const toggle = useCallback(() => {
    if (recording) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state !== 'inactive') {
        mediaRecorderRef.current?.stop();
      }
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    };
  }, []);

  const displayError = localError ?? transcriptionError;

  return (
    <>
      <div className="vr-wrap">
        {displayError && (
          <span className="vr-error" title={displayError}>mic</span>
        )}

        <button
          className={`vr-btn${recording ? ' recording' : ''}${processing ? ' processing' : ''}`}
          onClick={toggle}
          disabled={disabled || processing}
          aria-label={recording ? 'Stop recording' : processing ? 'Processing…' : 'Voice input'}
          title={recording ? 'Stop' : processing ? 'Processing…' : 'Voice input'}
          type="button"
        >
          {processing ? (
            <span className="vr-spinner" aria-hidden="true" />
          ) : recording ? (
            /* Stop square */
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          ) : (
            /* Mic outline */
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="9" y1="22" x2="15" y2="22" />
            </svg>
          )}
        </button>

        {recording && (
          <span className="vr-duration" aria-live="polite">{formatDuration(duration)}</span>
        )}
      </div>

      <style>{`
        .vr-wrap {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
          flex-shrink: 0;
        }

        /* Mic button — quiet at rest, ember when live */
        .vr-btn {
          width: 2rem;
          height: 2rem;
          display: grid;
          place-items: center;
          background: transparent;
          border: none;
          border-radius: 999px;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          flex-shrink: 0;
          transition:
            color var(--tx-fast, 240ms ease),
            background var(--tx-fast, 240ms ease),
            transform 140ms ease;
        }

        .vr-btn:hover:not(:disabled) {
          color: var(--text-secondary, #a09689);
          background: rgba(255, 255, 255, 0.04);
        }

        .vr-btn:active:not(:disabled) {
          transform: scale(0.945);
        }

        /* Recording — ember amber, pulsing */
        .vr-btn.recording {
          color: var(--amber, #c9a87c);
          /* Warm amber halo */
          box-shadow: 0 0 0 1px rgba(201, 168, 124, 0.22), 0 0 12px rgba(201, 168, 124, 0.16);
          animation: vrEmberBreath 1.8s ease-in-out infinite;
        }

        @keyframes vrEmberBreath {
          0%, 100% { box-shadow: 0 0 0 1px rgba(201, 168, 124, 0.18), 0 0 8px rgba(201, 168, 124, 0.12); }
          50%       { box-shadow: 0 0 0 1px rgba(201, 168, 124, 0.35), 0 0 18px rgba(201, 168, 124, 0.24); }
        }

        /* Processing — wait cursor, opacity dimmed */
        .vr-btn.processing {
          opacity: 0.6;
          cursor: wait;
        }

        .vr-btn:disabled:not(.processing) {
          cursor: not-allowed;
          opacity: 0.35;
        }

        /* Duration — mono, muted, minimal width */
        .vr-duration {
          font-size: 0.6875rem;
          font-family: var(--font-mono, monospace);
          color: var(--amber-dim, #a08960);
          min-width: 2.25rem;
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.02em;
        }

        /* Error badge — shown as a tiny dot, not prose */
        .vr-error {
          font-size: 0.5rem;
          color: var(--status-error-text);
          font-family: var(--font-mono, monospace);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          max-width: 2rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Spinner — bronze border, transparent top */
        .vr-spinner {
          display: block;
          width: 14px;
          height: 14px;
          border: 1.75px solid rgba(201, 168, 124, 0.35);
          border-top-color: var(--amber, #c9a87c);
          border-radius: 50%;
          animation: vrSpin 0.75s linear infinite;
        }

        @keyframes vrSpin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
