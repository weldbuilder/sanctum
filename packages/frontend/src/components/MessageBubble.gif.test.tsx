import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GifBlock, readGif } from './MessageBubble';

describe('a companion gif in the chat', () => {
  it('renders as an image with the title as alt and a GIF badge', () => {
    const gif = readGif('gif', { gif_url: 'https://media.giphy.com/g1.gif', gif_title: 'Funny cat GIF', source: 'giphy' })!;
    const html = renderToStaticMarkup(<GifBlock gif={gif} />);
    expect(html).toContain('src="https://media.giphy.com/g1.gif"');
    expect(html).toContain('alt="Funny cat GIF"');
    expect(html).toContain('>GIF</span>');
  });
  it('falls back to "GIF" for alt when there is no title, and refuses a non-https or missing url', () => {
    expect(renderToStaticMarkup(<GifBlock gif={readGif('gif', { gif_url: 'https://x/y.gif' })!} />)).toContain('alt="GIF"');
    expect(readGif('gif', { gif_url: 'http://x/y.gif' })).toBeNull();
    expect(readGif('gif', { gif_url: 'javascript:alert(1)' })).toBeNull();
    expect(readGif('gif', {})).toBeNull();
    expect(readGif('image', { gif_url: 'https://x/y.gif' })).toBeNull();
  });
});
