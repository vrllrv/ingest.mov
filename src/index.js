export default {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // Map request to file
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    // Simple HTML response for now - serve directly
    const files = {
      '/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ingest.mov</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <canvas id="canvas"></canvas>
    <div class="overlay">
        <h1>ingest.mov</h1>
        <p>cinema frame processing</p>
    </div>
    <script src="shader.js"><\/script>
</body>
</html>`,
      '/style.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: #000;
    font-family: 'Courier New', monospace;
}

canvas {
    display: block;
    width: 100%;
    height: 100%;
}

.overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    pointer-events: none;
    z-index: 10;
}

h1 {
    font-size: 3rem;
    color: #fff;
    text-shadow: 0 0 20px rgba(255,255,255,0.3), 0 0 40px rgba(100,200,255,0.2);
    margin-bottom: 10px;
    font-weight: 300;
    letter-spacing: 4px;
}

p {
    font-size: 0.9rem;
    color: #888;
    letter-spacing: 2px;
    text-transform: uppercase;
}`,
      '/shader.js': `const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const chars = '░▒▓█▀▄─│╱╲╲'.split('');
const gridW = Math.floor(canvas.width / 8);
const gridH = Math.floor(canvas.height / 16);

let time = 0;

function noise(x, y, t) {
  return Math.sin(x * 0.1 + t * 0.3) * Math.cos(y * 0.1 + t * 0.2) * 0.5 + 0.5;
}

function draw() {
  time += 0.016;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px Courier New';
  ctx.letterSpacing = '2px';

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const n = noise(x, y, time);
      const wave = Math.sin((x + time * 0.5) * 0.1) * 0.3 + 0.3;
      const depth = Math.sin((y - time * 0.3) * 0.15) * 0.4 + 0.4;

      let val = (n + wave + depth) / 2;
      val = Math.max(0, Math.min(1, val));

      const charIndex = Math.floor(val * (chars.length - 1));
      const char = chars[charIndex];

      const alpha = val * 0.8;
      ctx.fillStyle = \`rgba(255, 255, 255, \${alpha})\`;

      ctx.fillText(char, x * 8, y * 16);
    }
  }

  requestAnimationFrame(draw);
}

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

draw();`
    };

    const content = files[pathname];
    if (content) {
      const contentType = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'application/javascript' : 'text/html';
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
