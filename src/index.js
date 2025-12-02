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
    <title>Hello World</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="container">
        <h1>Hello World!</h1>
        <p>Welcome to your Cloudflare Pages website.</p>
        <p>This is a simple static site hosted on Cloudflare.</p>
    </div>
</body>
</html>`,
      '/style.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
}

.container {
    background: white;
    padding: 40px;
    border-radius: 10px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    text-align: center;
    max-width: 500px;
}

h1 {
    color: #667eea;
    margin-bottom: 20px;
    font-size: 2.5rem;
}

p {
    color: #666;
    line-height: 1.6;
    margin-bottom: 10px;
}`
    };

    const content = files[pathname];
    if (content) {
      const contentType = pathname.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
