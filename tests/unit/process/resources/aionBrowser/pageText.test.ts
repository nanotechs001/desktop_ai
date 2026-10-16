import { describe, expect, it } from 'vitest';
import { sanitizePageText } from '@process/resources/builtinMcp/aionBrowser/pageText';

describe('sanitizePageText', () => {
  it('does not split a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(199)}😀b`;
    expect(sanitizePageText(text, 200)).toBe(`${'a'.repeat(199)}😀`);
    expect(sanitizePageText(`${'a'.repeat(200)}😀`, 200)).toBe('a'.repeat(200));
  });

  it('keeps ZWJ and ZWNJ so emoji sequences and Persian/Indic text survive', () => {
    const family = '👨‍👩‍👧';
    const persian = 'می‌خواهم';
    expect(sanitizePageText(`${family} ${persian}`, 100)).toBe(`${family} ${persian}`);
  });

  it('turns controls, bidi controls, other format characters and separators into single spaces', () => {
    const hostile = 'a\u0000b‮c⁦d‏e؜f g\u0085h﻿i\n\n j';
    expect(sanitizePageText(hostile, 100)).toBe('a b c d e f g h i j');
  });

  it('trims and cuts to max', () => {
    expect(sanitizePageText('  hello  ', 3)).toBe('hel');
  });
});
