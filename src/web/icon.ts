import fs from 'node:fs';

const asset = (name: string) => new URL(`../../assets/${name}`, import.meta.url);

/** The app icon as a standalone file: its own light/dark colors, for the favicon. */
export const ICON = fs.readFileSync(asset('icon.svg'), 'utf8');
/** For inlining in a page: without the file's colors, so the mask takes the text color (currentColor). */
export const ICON_INLINE = ICON.replace(/<style>.*?<\/style>\s*/s, '').replace('<svg ', '<svg class="icon" aria-hidden="true" ');
export const APPLE_TOUCH_ICON = fs.readFileSync(asset('apple-touch-icon.png'));
