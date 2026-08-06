// Railway で静的サイトを配信するための最小サーバー。
// GitHub Pages と同じ内容を同じリポジトリから配信する。
// 依存パッケージなし（Node.js 標準機能のみ）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;

// 公開してよいファイルだけを配信する（ホワイトリスト方式）。
// メモ・バックアップ・.env などがリポジトリに紛れても配信されない。
const allowedFiles = new Set([
  "/index.html",
  "/privacy.html",
  "/robots.txt",
  "/sitemap.xml",
  "/google25944ef5cc9b8c1a.html",
]);
const allowedDirs = ["/images/"];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad Request");
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";

  // 正規化して、ディレクトリを遡る細工（../）を無効化する。
  const normalized = path.posix.normalize(urlPath);
  const isAllowed =
    allowedFiles.has(normalized) ||
    allowedDirs.some((dir) => normalized.startsWith(dir));

  if (!isAllowed) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>404 Not Found</h1>");
    return;
  }

  const filePath = path.join(root, normalized);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>404 Not Found</h1>");
      return;
    }
    const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=600" });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`listening on port ${port}`);
});
