import { ImageResponse } from 'next/og';
import { readFile } from 'fs/promises';
import path from 'path';

// Node.js runtime (not edge) — `fetch(new URL(..., import.meta.url))`, the
// usual pattern for loading local assets from an edge route, failed with
// ECONNREFUSED in local dev on this machine (likely the non-ASCII/spaced
// repo path); fs.readFile is the reliable option and next/og's ImageResponse
// supports both runtimes equally well for a static image like this one.
export const alt = 'House of Business — מערכת AI לניהול עסקים';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Satori (the renderer behind ImageResponse) has no default Hebrew glyph
// coverage, so the Hebrew subtitle below rendered as blank space in shared
// previews (WhatsApp/Facebook) without an explicit font. Rubik is the same
// family the rest of the site already uses (see layout.tsx's next/font/google
// import) — bundling it here keeps the share image visually consistent with
// the real site instead of introducing a second typeface just for this image.
async function loadFont(file: string) {
  return readFile(path.join(process.cwd(), 'src/app/fonts', file));
}

// Satori has no Unicode bidi support — CSS `direction: 'rtl'` is inert for
// text reordering (confirmed by testing: identical output with or without
// it), so a Hebrew string typed/stored in logical (reading) order renders
// its glyphs left-to-right in that same raw order, i.e. visually reversed.
// Reversing the character array flips it back to correct visual order —
// safe here because each string below is pure Hebrew plus simple punctuation
// (no embedded Latin words or digits, which a blind full-string reverse
// would also incorrectly flip).
const rtl = (s: string) => [...s].reverse().join('');

export default async function OGImage() {
  const [regular, semibold, bold, black] = await Promise.all([
    loadFont('Rubik-Regular.ttf'),
    loadFont('Rubik-SemiBold.ttf'),
    loadFont('Rubik-Bold.ttf'),
    loadFont('Rubik-Black.ttf'),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200, height: 630,
          background: '#050507',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          fontFamily: 'Rubik',
          direction: 'rtl',
        }}
      >
        {/* Grid pattern */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'linear-gradient(rgba(201,162,39,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(201,162,39,0.05) 1px,transparent 1px)',
          backgroundSize: '60px 60px',
        }} />

        {/* Gold glow center */}
        <div style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%,-50%)',
          width: 800, height: 400,
          background: 'radial-gradient(ellipse,rgba(201,162,39,0.08),transparent 70%)',
        }} />

        {/* HOB Badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 80, height: 80,
          background: 'linear-gradient(135deg,#b8941f,#c9a227,#d4af37)',
          borderRadius: 20,
          marginBottom: 32,
          fontSize: 28,
          fontWeight: 900,
          color: '#050507',
        }}>
          HB
        </div>

        {/* Title */}
        <div style={{
          display: 'flex',
          fontSize: 64,
          fontWeight: 900,
          color: '#f0ece6',
          letterSpacing: '-2px',
          marginBottom: 8,
          textAlign: 'center',
        }}>
          House of{' '}
          <span style={{ color: '#c9a227' }}>Business</span>
        </div>

        {/* Subtitle */}
        <div style={{
          fontSize: 26,
          color: 'rgba(228,228,228,0.55)',
          marginBottom: 40,
          textAlign: 'center',
        }}>
          {rtl('כל מה שהעסק צריך, במקום אחד')}
        </div>

        {/* Pills */}
        <div style={{ display: 'flex', gap: 12 }}>
          {['AI Agents', rtl('ניתוח עסקי'), rtl('שיווק אוטומטי'), rtl('ניהול מלאי')].map(t => (
            <div key={t} style={{
              padding: '8px 20px',
              borderRadius: 999,
              background: 'rgba(201,162,39,0.08)',
              border: '1px solid rgba(201,162,39,0.3)',
              fontSize: 16,
              color: '#c9a227',
              fontWeight: 600,
            }}>
              {t}
            </div>
          ))}
        </div>

        {/* Bottom URL */}
        <div style={{
          position: 'absolute',
          bottom: 36,
          fontSize: 16,
          color: 'rgba(201,162,39,0.35)',
          letterSpacing: '1px',
        }}>
          houseofbusiness.co.il
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Rubik', data: regular,  weight: 400, style: 'normal' },
        { name: 'Rubik', data: semibold, weight: 600, style: 'normal' },
        { name: 'Rubik', data: bold,     weight: 700, style: 'normal' },
        { name: 'Rubik', data: black,    weight: 900, style: 'normal' },
      ],
    }
  );
}
