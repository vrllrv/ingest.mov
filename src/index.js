/**
 * Static site server for Cloudflare Workers
 * Serves index.html, style.css, and shader.js files
 * Files are bundled at build time by Wrangler
 */

// Static content - bundled at build time
// Edit the actual files (index.html, style.css, src/shader.js) and redeploy
export default {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // Map request to file
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    const files = {
      '/index.html': {
        content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>INGEST.mov</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Degular+Mono:wght@400;700&family=Swear+Display:wght@400;700&display=swap">
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <canvas id="canvas"></canvas>
    <div class="overlay">
        <h1>INGEST<span class="extension">.mov</span></h1>
        <p>DIGITAL PACKAGE NETWORK</p>
    </div>
    <script src="shader.js"><\/script>
</body>
</html>`,
        type: 'text/html'
      },
      '/style.css': {
        content: `* {
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
    font-family: "degular-mono", sans-serif;
    font-weight: 700;
    font-style: normal;
    font-size: 2rem;
    color: #fff;
    margin: 0;
    letter-spacing: 4px;
}

h1 .extension {
    font-family: "swear-display", serif;
    font-weight: 700;
    font-style: italic;
    font-size: 3.0rem;
    margin-left: -6px;
    letter-spacing: -0.05em;
}

p {
    font-family: "swear-display", serif;
    font-weight: 400;
    font-style: normal;
    font-size: 0.65rem;
    color: #fff;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin: 4px 0 0 0;
}`,
        type: 'text/css'
      },
      '/shader.js': {
        content: `const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const chars = '░▒▓█▀▄─│╱╲╲'.split('');
const gridW = Math.floor(canvas.width / 8);
const gridH = Math.floor(canvas.height / 16);

let time = 0;
let mouseX = canvas.width / 2;
let mouseY = canvas.height / 2;
let touchIntensity = 1;
let isTouching = false;
let shuffleChars = false;
let shaderPattern = 0;
let lastTapTime = 0;
const allChars = '░▒▓█▀▄─│╱╲◆◇▪▫■□▌▐▍▎◀▶▲▼◤◥◢◣╔╗╚╝╟╢╡╢═║╬╪╫╤╥╧╨╩╦╤╧╥╩╬─│┌┐└┘├┤┬┴┼'.split('');

document.addEventListener('mousemove', (e) => {
  if (!isTouching) {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }
});

// Desktop double-click for shader pattern
document.addEventListener('dblclick', (e) => {
  if (!isTouching) {
    shaderPattern = (shaderPattern + 1) % 3;
  }
  e.preventDefault();
});

document.addEventListener('touchstart', (e) => {
  isTouching = true;
  const currentTime = new Date().getTime();
  const tapLength = currentTime - lastTapTime;
  if (tapLength < 300 && tapLength > 0) {
    shaderPattern = (shaderPattern + 1) % 3;
  }
  lastTapTime = currentTime;
});

document.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) {
    isTouching = false;
  }
});

document.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1) {
    mouseX = e.touches[0].clientX;
    mouseY = e.touches[0].clientY;
    touchIntensity = 2;
    shuffleChars = false;
  } else if (e.touches.length >= 2) {
    mouseX = e.touches[0].clientX;
    mouseY = e.touches[0].clientY;
    touchIntensity = 3;
    shuffleChars = true;
  }
  e.preventDefault();
}, { passive: false });

function noise(x, y, t) {
  return Math.sin(x * 0.1 + t * 0.3) * Math.cos(y * 0.1 + t * 0.2) * 0.5 + 0.5;
}

function draw() {
  time += 0.016;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 14px Courier New';
  ctx.letterSpacing = '2px';

  const mouseGridX = Math.floor(mouseX / 8);
  const mouseGridY = Math.floor(mouseY / 16);
  const pattern = shaderPattern % 5;

  // Pre-calculate pattern-specific constants
  let speedMultiplier, waveIntensity;
  if (touchIntensity === 2) {
    speedMultiplier = 2.5;
    waveIntensity = 0.5;
  } else if (touchIntensity === 3) {
    speedMultiplier = 4;
    waveIntensity = 0.7;
  } else {
    speedMultiplier = 1;
    waveIntensity = 0.3;
  }

  // Pattern-specific pre-calculations
  let fillAmount, blockFill, pulsePhase, timeOffsetX, timeOffsetY;
  if (pattern === 1) {
    fillAmount = (time * 0.4 * speedMultiplier) % (gridW * 0.8);
  } else if (pattern === 3) {
    blockFill = ((time * 0.6 * speedMultiplier) % 80) / 80;
  } else if (pattern === 4) {
    pulsePhase = Math.sin(time * 0.5 * speedMultiplier) * 0.5 + 0.5;
  }

  const timeX = time * speedMultiplier;
  const timeY = time * speedMultiplier;

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const n = noise(x, y, time);
      const dx = (mouseGridX - x) * 0.02;
      const dy = (mouseGridY - y) * 0.02;

      // Squared distance (avoid sqrt when possible)
      const distSq = (x - mouseGridX) ** 2 + (y - mouseGridY) ** 2;
      const mouseInfluence = Math.max(0, 1 - Math.sqrt(distSq) * 0.05);

      let wave, depth;

      if (pattern === 0) {
        wave = Math.sin((x + timeX * 0.5 + dx * 10) * 0.1) * waveIntensity + 0.3;
        depth = Math.sin((y - timeY * 0.3 + dy * 10) * 0.15) * (waveIntensity + 0.1) + 0.4;
      } else if (pattern === 1) {
        const distance = Math.abs(x - (gridW / 2 - gridW * 0.4 + fillAmount));
        wave = Math.sin(distance * 0.1 + timeY * 0.3) * waveIntensity + 0.3;
        depth = (distance < 5) ? 0.8 : 0.2;
      } else if (pattern === 2) {
        const scanLine = Math.floor((y + timeY * 0.5) % 8);
        const lineIntensity = (scanLine < 2) ? 0.9 : 0.1;
        wave = Math.sin(x * 0.08 + timeX * 0.2) * waveIntensity + 0.3;
        depth = lineIntensity + Math.cos(timeX * 0.6) * 0.2;
      } else if (pattern === 3) {
        const distFromCenter = Math.sqrt((x - gridW/2) ** 2 + (y - gridH/2) ** 2);
        const blockThreshold = gridH * blockFill * 0.4;
        wave = (distFromCenter < blockThreshold) ? 0.8 : 0.2;
        depth = Math.cos(Math.floor(distFromCenter / 4) * 0.5 + timeX * 0.4) * waveIntensity + 0.4;
      } else {
        const fillFromLeft = (x / gridW) * pulsePhase + (timeX * 0.2) % 1;
        wave = (fillFromLeft % 1 < 0.6) ? 0.85 : 0.25;
        depth = Math.sin((y + timeY * 0.3) * 0.15) * waveIntensity + 0.3;
      }

      let val = (n + wave + depth + mouseInfluence * (0.4 * touchIntensity)) / 2;
      val = Math.max(0, Math.min(1, val));

      let char = shuffleChars ? allChars[Math.floor(val * (allChars.length - 1))] : chars[Math.floor(val * (chars.length - 1))];
      const alpha = ((val * 0.8) + (mouseInfluence * 0.3 * touchIntensity)) * 0.68;

      ctx.fillStyle = \`rgba(255,255,255,\${alpha})\`;
      ctx.fillText(char, x * 8, y * 16);
    }
  }

  requestAnimationFrame(draw);
}

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

draw();`,
        type: 'application/javascript'
      }
    };

    const file = files[pathname];
    if (file) {
      return new Response(file.content, {
        headers: { 'Content-Type': file.type },
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
