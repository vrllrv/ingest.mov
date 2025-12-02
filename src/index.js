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
    <title>INGEST.MOV</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Degular:wght@400;700&family=Degular+Display:wght@400;700&family=Degular+Text:wght@400;700&display=swap">
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <canvas id="canvas"></canvas>
    <div class="overlay">
        <h1>INGEST.MOV</h1>
        <p>motion picture delivery</p>
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
    font-family: "degular-display", sans-serif;
    font-weight: 700;
    font-style: normal;
    font-size: 2rem;
    color: #fff;
    margin: 0;
    letter-spacing: 4px;
}

p {
    font-family: "degular-text", sans-serif;
    font-weight: 400;
    font-style: normal;
    font-size: 0.65rem;
    color: #fff;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin: 15px 0 0 0;
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
const allChars = '░▒▓█▀▄─│╱╲◆◇▪▫■□▌▐▍▎◀▶▲▼◤◥◢◣○●◎◉★✦✧×÷≈≠±∞∑∏√∂∫∮∆∇⊕⊗⊙⊚⊛⊝⊞⊟⊠⊡'.split('');

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
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px Courier New';
  ctx.letterSpacing = '2px';

  const mouseGridX = Math.floor(mouseX / 8);
  const mouseGridY = Math.floor(mouseY / 16);

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const n = noise(x, y, time);
      const dx = (mouseGridX - x) * 0.02;
      const dy = (mouseGridY - y) * 0.02;
      const distToMouse = Math.sqrt((x - mouseGridX) ** 2 + (y - mouseGridY) ** 2);
      const mouseInfluence = Math.max(0, 1 - distToMouse * 0.05);

      let speedMultiplier = 1;
      let waveIntensity = 0.3;

      if (touchIntensity === 2) {
        speedMultiplier = 2.5;
        waveIntensity = 0.5;
      } else if (touchIntensity === 3) {
        speedMultiplier = 4;
        waveIntensity = 0.7;
      }

      let wave, depth;

      if (shaderPattern === 0) {
        // Original spiral pattern - sine/sine diagonal flow
        wave = Math.sin((x + time * 0.5 * speedMultiplier + dx * 10) * 0.1) * waveIntensity + 0.3;
        depth = Math.sin((y - time * 0.3 * speedMultiplier + dy * 10) * 0.15) * (waveIntensity + 0.1) + 0.4;
      } else if (shaderPattern === 1) {
        // Radial burst pattern - concentric circles radiating outward
        const radialDist = Math.sqrt((x - gridW/2) ** 2 + (y - gridH/2) ** 2);
        wave = Math.sin(radialDist * 0.05 + time * 0.6 * speedMultiplier) * waveIntensity + 0.3;
        depth = Math.cos((radialDist - time * 0.4 * speedMultiplier) * 0.08) * (waveIntensity + 0.1) + 0.4;
      } else {
        // Turbulent vortex pattern - rotational flow from center
        const angle = Math.atan2(y - gridH/2, x - gridW/2);
        const radius = Math.sqrt((x - gridW/2) ** 2 + (y - gridH/2) ** 2);
        wave = Math.sin(angle * 4 + time * 0.7 * speedMultiplier + radius * 0.02) * waveIntensity + 0.3;
        depth = Math.cos(angle * 3 - time * 0.5 * speedMultiplier) * (waveIntensity + 0.1) + 0.4;
      }

      let val = (n + wave + depth + mouseInfluence * (0.4 * touchIntensity)) / 2;
      val = Math.max(0, Math.min(1, val));

      let charIndex = Math.floor(val * (chars.length - 1));
      let char = chars[charIndex];

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
