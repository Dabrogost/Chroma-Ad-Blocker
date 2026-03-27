/**
 * Shared utility for calculating Chroma colors.
 */

if (typeof window.CHROMA_PALETTE === 'undefined') {
  window.CHROMA_PALETTE = [
    [255,   0,  85], [153,   0, 255], [  0, 136, 255],
    [  0, 255, 136], [204, 255,   0], [255,  85,   0]
  ];
}

if (typeof window.calculateChromaColor === 'undefined') {
  /**
   * Calculates the interpolated RGB color based on a given time fraction.
   * @param {number} t - Time fraction (0.0 to 1.0)
   * @returns {number[]} Array containing [r, g, b] values.
   */
  window.calculateChromaColor = function(t) {
    const segCount = window.CHROMA_PALETTE.length;
    const raw = t * segCount;
    const idx = Math.floor(raw) % segCount;
    const frac = raw - Math.floor(raw);
    const next = (idx + 1) % segCount;

    const r = Math.round(window.CHROMA_PALETTE[idx][0] + (window.CHROMA_PALETTE[next][0] - window.CHROMA_PALETTE[idx][0]) * frac);
    const g = Math.round(window.CHROMA_PALETTE[idx][1] + (window.CHROMA_PALETTE[next][1] - window.CHROMA_PALETTE[idx][1]) * frac);
    const b = Math.round(window.CHROMA_PALETTE[idx][2] + (window.CHROMA_PALETTE[next][2] - window.CHROMA_PALETTE[idx][2]) * frac);

    return [r, g, b];
  };
}
