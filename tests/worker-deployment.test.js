const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const publicFiles = [
    "app.js",
    "icon-192.png",
    "icon-512.png",
    "index.html",
    "manifest.json",
    "service-worker.js",
    "styles.css"
];

test("Worker build emits only the approved public application files", () => {
    const fixture = fs.mkdtempSync(path.join(root, ".worker-build-fixture-"));
    try {
        for (const file of publicFiles) {
            fs.writeFileSync(path.join(fixture, file), file);
        }
        childProcess.execFileSync(process.execPath, ["scripts/build-worker-assets.js"], {
            cwd: root,
            env: { ...process.env, WORKER_BUILD_SOURCE_DIR: fixture },
            stdio: "pipe"
        });
        const output = path.join(root, "dist", "public");
        assert.deepEqual(fs.readdirSync(output).sort(), publicFiles);
        assert.equal(fs.existsSync(path.join(output, "README.md")), false);
        assert.equal(fs.existsSync(path.join(output, "docs")), false);
        assert.equal(fs.existsSync(path.join(output, "apps-script")), false);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
        fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
    }
});

test("Worker configuration distinguishes the noindex development deployment", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
    assert.equal(config.name, "gac-helper-dev");
    assert.equal(config.vars.NOINDEX, "true");
    assert.equal(config.env.production.name, "gac-helper");
    assert.equal(config.env.production.vars.NOINDEX, "false");
    assert.equal(config.assets.directory, "./dist/public");
    assert.equal(config.assets.binding, "ASSETS");
    assert.equal(config.assets.run_worker_first, true);
});

test("Worker adds noindex only when the deployment configuration asks for it", () => {
    const worker = fs.readFileSync(path.join(root, "workers", "static-assets.mjs"), "utf8");
    assert.match(worker, /env\.ASSETS\.fetch\(request\)/);
    assert.match(worker, /env\.NOINDEX === "true"/);
    assert.match(worker, /X-Robots-Tag/);
});

test("deployment workflows are manual, serialised and do not reference database credentials", () => {
    const deploy = fs.readFileSync(path.join(root, ".github", "workflows", "deploy-worker.yml"), "utf8");
    const rollback = fs.readFileSync(path.join(root, ".github", "workflows", "rollback-worker.yml"), "utf8");

    for (const workflow of [deploy, rollback]) {
        assert.match(workflow, /workflow_dispatch/);
        assert.match(workflow, /cancel-in-progress: false/);
        assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
        assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
        assert.doesNotMatch(workflow, /SUPABASE|DATABASE_URL|NEON/i);
    }
    assert.match(deploy, /github\.ref == 'refs\/heads\/main'/);
    assert.match(rollback, /wrangler rollback/);
});
