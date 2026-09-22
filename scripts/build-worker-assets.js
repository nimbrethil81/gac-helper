const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceRoot = process.env.WORKER_BUILD_SOURCE_DIR
    ? path.resolve(process.env.WORKER_BUILD_SOURCE_DIR)
    : root;
const output = path.join(root, "dist", "public");
const publicFiles = [
    "index.html",
    "app.js",
    "styles.css",
    "manifest.json",
    "service-worker.js",
    "icon-192.png",
    "icon-512.png"
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of publicFiles) {
    const source = path.join(sourceRoot, file);
    if (!fs.statSync(source).isFile()) {
        throw new Error(`Expected public asset is missing: ${file}`);
    }
    fs.copyFileSync(source, path.join(output, file));
}

console.log(`Built ${publicFiles.length} public Worker assets in ${path.relative(root, output)}.`);
