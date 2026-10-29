import type { CueFeed } from './subtitles';
import type { Cue } from './timedtext';

export interface TimedFeed extends CueFeed {
  /** The video the cues belong to; a player reused for the next video must not show these. */
  videoId: string;
}

export interface TimedFeedOptions {
  videoId: string;
  /** False while the viewer has the player's captions switched off. */
  enabled?: () => boolean;
  pollMs?: number;
}

/**
 * Cues with their times, followed against the video's own clock. The whole file is known, so
 * every line can be translated before it is due and shown the moment the player would show it.
 */
export function timedFeed(video: HTMLVideoElement, cues: Cue[], options: TimedFeedOptions): TimedFeed {
  const now = () => video.currentTime * 1000;
  const active = () => {
    if (options.enabled && !options.enabled()) return [];
    const time = now();
    const out: string[] = [];
    for (const cue of cues) if (cue.start <= time && time < cue.end && !out.includes(cue.text)) out.push(cue.text);
    return out;
  };
  return {
    videoId: options.videoId,
    active,
    // What is about to be said first, so a long file is translated from where the viewer is.
    all() {
      const time = now();
      const from = Math.max(0, cues.findIndex((cue) => cue.end > time));
      return [...new Set([...cues.slice(from), ...cues.slice(0, from)].map((cue) => cue.text))];
    },
    onChange(listener) {
      let last = JSON.stringify(active());
      const check = () => {
        const key = JSON.stringify(active());
        if (key === last) return;
        last = key;
        listener();
      };
      const timer = setInterval(check, options.pollMs ?? 100);
      video.addEventListener('seeked', check);
      return () => {
        clearInterval(timer);
        video.removeEventListener('seeked', check);
      };
    },
    release() {},
  };
}
