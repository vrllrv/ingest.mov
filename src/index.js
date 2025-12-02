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
    <link rel="stylesheet" href="https://use.typekit.net/sby2vmx.css">
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
    font-family: "carbona-variable", sans-serif;
    font-variation-settings: "slnt" 0, "MONO" 0, "wght" 800;
    font-size: 2rem;
    color: #fff;
    margin: 0;
    font-weight: 800;
    letter-spacing: 4px;
}

p {
    font-family: "carbona-variable", sans-serif;
    font-variation-settings: "slnt" 0, "MONO" 0, "wght" 400;
    font-size: 0.65rem;
    color: #fff;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin: 15px 0 0 0;
}`,
      '/shader.js': `const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const chars = '░▒▓█▀▄─│╱╲╲'.split('');
const gridW = Math.floor(canvas.width / 8);
const gridH = Math.floor(canvas.height / 16);

let time = 0;
let mouseX = canvas.width / 2;
let mouseY = canvas.height / 2;
let touchIntensity = 1; // 1 for single touch (chaotic), 2+ for multi-touch (ultra chaotic)
let isTouching = false;
let shuffleChars = false;
let shaderPattern = 0; // 0 = default, 1 = swapped wave/depth, 2 = inverted
let lastTapTime = 0;
const allChars = '░▒▓█▀▄─│╱╲◆◇▪▫■□▌▐▍▎◀▶▲▼◤◥◢◣○●◎◉★✦✧×÷≈≠±∞∑∏√∂∫∮∆∇⊕⊗⊙⊚⊛⊝⊞⊟⊠⊡'.split('');

document.addEventListener('mousemove', (e) => {
  if (!isTouching) {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }
});

// Touch controls
document.addEventListener('touchstart', (e) => {
  isTouching = true;

  // Double tap detection
  const currentTime = new Date().getTime();
  const tapLength = currentTime - lastTapTime;
  if (tapLength < 300 && tapLength > 0) {
    // Double tap detected - cycle shader pattern
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
    // Single finger - chaotic flow (default on mobile)
    mouseX = e.touches[0].clientX;
    mouseY = e.touches[0].clientY;
    touchIntensity = 2;
    shuffleChars = false;
  } else if (e.touches.length >= 2) {
    // Two or more fingers - ultra intense chaotic + shuffle characters
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

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px Courier New';
  ctx.letterSpacing = '2px';

  // Convert mouse position to grid coords
  const mouseGridX = Math.floor(mouseX / 8);
  const mouseGridY = Math.floor(mouseY / 16);

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const n = noise(x, y, time);

      // Direction toward mouse
      const dx = (mouseGridX - x) * 0.02;
      const dy = (mouseGridY - y) * 0.02;

      // Distance to mouse creates intensity
      const distToMouse = Math.sqrt((x - mouseGridX) ** 2 + (y - mouseGridY) ** 2);
      const mouseInfluence = Math.max(0, 1 - distToMouse * 0.05);

      // Touch intensity multipliers
      let speedMultiplier = 1;
      let waveIntensity = 0.3;

      if (touchIntensity === 2) {
        // Single finger on mobile - chaotic
        speedMultiplier = 2.5;
        waveIntensity = 0.5;
      } else if (touchIntensity === 3) {
        // Two fingers - ultra chaotic
        speedMultiplier = 4;
        waveIntensity = 0.7;
      }

      let wave, depth;

      if (shaderPattern === 0) {
        // Default pattern
        wave = Math.sin((x + time * 0.5 * speedMultiplier + dx * 10) * 0.1) * waveIntensity + 0.3;
        depth = Math.sin((y - time * 0.3 * speedMultiplier + dy * 10) * 0.15) * (waveIntensity + 0.1) + 0.4;
      } else if (shaderPattern === 1) {
        // Swapped pattern
        wave = Math.cos((x - time * 0.3 * speedMultiplier + dx * 10) * 0.15) * waveIntensity + 0.3;
        depth = Math.cos((y + time * 0.5 * speedMultiplier + dy * 10) * 0.1) * (waveIntensity + 0.1) + 0.4;
      } else {
        // Inverted pattern
        wave = Math.sin((x + time * 0.4 * speedMultiplier + dx * 10) * 0.12) * waveIntensity + 0.3;
        depth = Math.cos((y - time * 0.4 * speedMultiplier + dy * 10) * 0.12) * (waveIntensity + 0.1) + 0.4;
      }

      let val = (n + wave + depth + mouseInfluence * (0.4 * touchIntensity)) / 2;
      val = Math.max(0, Math.min(1, val));

      let charIndex = Math.floor(val * (chars.length - 1));
      let char = chars[charIndex];

      // Shuffle characters when two fingers active
      if (shuffleChars) {
        charIndex = Math.floor(val * (allChars.length - 1));
        char = allChars[charIndex];
      }

      const alpha = ((val * 0.8) + (mouseInfluence * 0.3 * touchIntensity)) * 0.68;
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
