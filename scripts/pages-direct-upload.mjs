import { hash } from "blake3-wasm";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const jwt = process.env.CF_PAGES_UPLOAD_JWT;

if (!jwt) {
  console.error("CF_PAGES_UPLOAD_JWT is required.");
  process.exit(1);
}

const ignored = new Set(["_worker.js", "_worker.bundle", "_redirects", "_headers", "_routes.json", "functions", "node_modules", ".git"]);

function contentType(fileName) {
  if (fileName.endsWith(".html")) return "text/html";
  if (fileName.endsWith(".css")) return "text/css";
  if (fileName.endsWith(".js")) return "application/javascript";
  if (fileName.endsWith(".json") || fileName.endsWith(".webmanifest")) return "application/json";
  if (fileName.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function walk(dir, base = dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if ([...ignored].some((name) => rel === name || rel.startsWith(`${name}/`))) continue;
    if (entry.isDirectory()) await walk(abs, base, files);
    else if (entry.isFile()) files.push({ abs, rel });
  }
  return files;
}

const files = await walk(distDir);
const manifestEntries = [];

for (const file of files) {
  const bytes = await fs.readFile(file.abs);
  const base64 = bytes.toString("base64");
  const extension = path.extname(file.rel).slice(1);
  manifestEntries.push({
    ...file,
    hash: hash(`${base64}${extension}`).toString("hex").slice(0, 32),
    base64,
    contentType: contentType(file.rel)
  });
}

const check = await fetch("https://api.cloudflare.com/client/v4/pages/assets/check-missing", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`
  },
  body: JSON.stringify({ hashes: manifestEntries.map((file) => file.hash) })
});

if (!check.ok) {
  throw new Error(`check-missing failed: ${check.status} ${await check.text()}`);
}

const missing = new Set((await check.json()).result ?? []);
const missingFiles = manifestEntries.filter((file) => missing.has(file.hash));

if (missingFiles.length) {
  const upload = await fetch("https://api.cloudflare.com/client/v4/pages/assets/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify(
      missingFiles.map((file) => ({
        key: file.hash,
        value: file.base64,
        metadata: { contentType: file.contentType },
        base64: true
      }))
    )
  });
  if (!upload.ok) {
    throw new Error(`assets/upload failed: ${upload.status} ${await upload.text()}`);
  }
}

const upsert = await fetch("https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`
  },
  body: JSON.stringify({ hashes: manifestEntries.map((file) => file.hash) })
});

if (!upsert.ok) {
  throw new Error(`upsert-hashes failed: ${upsert.status} ${await upsert.text()}`);
}

const manifest = Object.fromEntries(manifestEntries.map((file) => [`/${file.rel}`, file.hash]));
await fs.writeFile(path.join(root, "dist", "pages-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ uploaded: missingFiles.length, total: manifestEntries.length, manifest }, null, 2));
