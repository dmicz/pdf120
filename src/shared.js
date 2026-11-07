// Constants shared by the viewer and the render worker.

// Dark-mode page treatment. invert(0.92) maps white paper to #141414 rather
// than pure black, and hue-rotate keeps colored figures recognizable.
export const INVERT_FILTER = "invert(0.92) hue-rotate(180deg)";

// PDF points -> CSS px at 100% zoom.
export const PT_TO_CSS = 96 / 72;
