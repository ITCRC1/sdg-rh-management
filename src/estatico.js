"use strict";
// Servido de archivos estáticos: gzip, ETag/304 y bloqueo de path traversal.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..", "vscode_project");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const COMPRIMIBLES = new Set([".html", ".js", ".css", ".json", ".md", ".txt", ".svg"]);
const cacheGzip = new Map();

function rutaSegura(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch (e) {
    return null;
  }
  if (p.endsWith("/")) p += "index.html";
  const completa = path.normalize(path.join(ROOT, p));
  if (completa !== ROOT && !completa.startsWith(ROOT + path.sep)) return null;
  return completa;
}

function statArchivo(ruta) {
  try {
    const st = fs.statSync(ruta);
    return st.isFile() ? st : null;
  } catch (e) {
    return null;
  }
}

function servir(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const ruta = rutaSegura(urlPath);
  if (!ruta) {
    res.statusCode = 400;
    return res.end("Ruta inválida");
  }

  let destino = ruta;
  let st = statArchivo(destino);
  if (!st && !path.extname(destino)) {
    destino = ruta + ".html";
    st = statArchivo(destino);
  }
  if (!st) return next();

  const ext = path.extname(destino).toLowerCase();
  const etag = '"' + st.size.toString(16) + "-" + st.mtimeMs.toString(16) + '"';

  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    return res.end();
  }

  let contenido;
  try {
    contenido = fs.readFileSync(destino);
  } catch (e) {
    return next(e);
  }

  const aceptaGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (aceptaGzip && COMPRIMIBLES.has(ext) && contenido.length > 1024) {
    const guardado = cacheGzip.get(destino);
    if (guardado && guardado.etag === etag) {
      contenido = guardado.buf;
    } else {
      contenido = zlib.gzipSync(contenido, { level: 6 });
      cacheGzip.set(destino, { etag, buf: contenido });
    }
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
  }

  res.setHeader("Content-Length", contenido.length);
  res.end(req.method === "HEAD" ? undefined : contenido);
}

module.exports = { servir, ROOT };
