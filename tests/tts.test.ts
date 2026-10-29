import { describe, expect, it } from 'vitest';
import { pickVoice, splitForSpeech } from '../src/content/tts';

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

describe('splitForSpeech', () => {
  it('splits on sentence ends and packs sentences up to the limit', () => {
    const text = '第一句话。第二句话。第三句话。';
    expect(splitForSpeech(text, 10)).toEqual(['第一句话。第二句话。', '第三句话。']);
  });

  it('does not split decimals', () => {
    expect(splitForSpeech('Growth was 3.5% last year. It slowed.', 200)).toEqual(['Growth was 3.5% last year. It slowed.']);
  });

  it('keeps one long sentence whole and drops empties', () => {
    expect(splitForSpeech('   ')).toEqual([]);
    expect(splitForSpeech('a'.repeat(300))).toHaveLength(1);
  });
});

describe('pickVoice', () => {
  const voices = [
    voice('Microsoft Huihui', 'zh-CN'),
    voice('Microsoft Xiaoxiao Online (Natural)', 'zh-CN'),
    voice('Google 國語', 'zh-TW'),
    voice('Samantha', 'en-US'),
  ];

  it('prefers natural voices in the exact language', () => {
    expect(pickVoice(voices, 'zh-CN')?.name).toBe('Microsoft Xiaoxiao Online (Natural)');
  });

  it('falls back to the same base language', () => {
    expect(pickVoice(voices, 'en-GB')?.name).toBe('Samantha');
  });

  it('finds Cantonese voices for zh-HK', () => {
    const list = [...voices, voice('Microsoft HiuGaai Online (Natural)', 'zh-HK'), voice('Sinji', 'zh-HK')];
    expect(pickVoice(list, 'zh-HK')?.name).toBe('Microsoft HiuGaai Online (Natural)');
  });

  it('returns undefined when no voice matches', () => {
    expect(pickVoice(voices, 'ja')).toBeUndefined();
  });
});
