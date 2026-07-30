import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const directoryArg = process.argv.indexOf("--directory");
const portArg = process.argv.indexOf("--port");
const root = path.resolve(directoryArg >= 0 ? process.argv[directoryArg + 1] : ".preview");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : 8765);
const types = new Map([
  [".html", "text/html;charset=UTF-8"], [".css", "text/css;charset=UTF-8"],
  [".js", "application/javascript;charset=UTF-8"], [".json", "application/json;charset=UTF-8"],
  [".webmanifest", "application/manifest+json;charset=UTF-8"]
]);
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'";

http.createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/u, "");
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain;charset=UTF-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": types.get(path.extname(file)) ?? "application/octet-stream",
    "Content-Security-Policy": csp, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
  });
  fs.createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${port}`));
