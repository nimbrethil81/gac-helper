const BUILD_ID = "__GAC_BUILD_ID__";
const SHELL_FILES = /* gac shell files */ [];
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `gac-app-shell:${SCOPE.pathname}:`;
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const BUILD_ID_PATTERN = /^[0-9a-f]{64}$/;
const shellUrl = (file) => new URL(file, SCOPE).href;
const READY = shellUrl(".gac-shell-ready");
const ACTIVE = shellUrl(".gac-shell-active");

function buildMetadata(value) {
    return Object.keys(value ?? {}).sort().join() === "assets,buildId,contract,version" &&
        value.contract === "gac-app-build:v1" && value.buildId === BUILD_ID &&
        typeof value.version === "string" && /^[0-9]+(?:\.[0-9]+)+$/.test(value.version) &&
        Object.keys(value.assets ?? {}).length === SHELL_FILES.length &&
        SHELL_FILES.every(file => {
            const entry = value.assets[file];
            return Object.keys(entry ?? {}).sort().join() === "bytes,sha256" &&
                Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && BUILD_ID_PATTERN.test(entry.sha256);
        });
}

async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function prepareShell() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const options = { cache: "no-store", redirect: "error", signal: controller.signal };
    let created = false;
    try {
        const response = await fetch(shellUrl(`app-build.json?check=${Date.now()}`), options);
        if (!response.ok) throw new Error("App build metadata is unavailable");
        const metadataBytes = await response.arrayBuffer();
        const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
        if (!buildMetadata(metadata)) throw new Error("App build metadata does not match the installing worker");
        // Validate the whole release before touching CacheStorage. A stopped or
        // partially propagated deploy must leave the previous shell usable.
        const entries = await Promise.all([...SHELL_FILES, ""].map(async file => {
            const asset = await fetch(shellUrl(`${file}?build=${BUILD_ID}`), options);
            if (!asset.ok) throw new Error(`App shell unavailable: ${file || "site root"}`);
            const bytes = await asset.clone().arrayBuffer();
            const expected = metadata.assets[file || "index.html"];
            if (bytes.byteLength !== expected.bytes || await sha256(bytes) !== expected.sha256) {
                throw new Error(`App shell verification failed: ${file || "site root"}`);
            }
            return [shellUrl(file), asset];
        }));
        created = !await caches.has(CACHE_NAME);
        const cache = await caches.open(CACHE_NAME);
        // A rollback can reuse an earlier cache. Repair any missing entry
        // using the fresh, already verified bytes.
        for (const [url, asset] of entries) {
            if (!await cache.match(url)) await cache.put(url, asset);
        }
        await cache.put(READY, new Response(JSON.stringify({ preparedAt: Date.now(), metadataHash: await sha256(metadataBytes) })));
    } catch (error) {
        controller.abort();
        if (created) await caches.delete(CACHE_NAME);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function ownedShellCaches() {
    return (await caches.keys()).filter(key => key !== CACHE_NAME && key.startsWith(CACHE_PREFIX) &&
        BUILD_ID_PATTERN.test(key.slice(CACHE_PREFIX.length)));
}

async function discardSupersededInstalls() {
    // Preserve the closest previous candidate until install finishes. A
    // different waiting worker may still be selected while this one stages.
    const staged = [];
    for (const key of await ownedShellCaches()) {
        if (await caches.match(ACTIVE, { cacheName: key })) continue;
        const ready = await caches.match(READY, { cacheName: key });
        if (ready) staged.push({ key, preparedAt: (await ready.json()).preparedAt });
    }
    staged.sort((a, b) => b.preparedAt - a.preparedAt);
    await Promise.all(staged.slice(1).map(entry => caches.delete(entry.key)));
}

async function claimShell() {
    const cache = await caches.open(CACHE_NAME);
    const activatedAt = Date.now();
    await cache.put(ACTIVE, new Response(String(activatedAt)));
    await self.clients.claim();
    const older = [];
    for (const key of await ownedShellCaches()) {
        const active = await caches.match(ACTIVE, { cacheName: key });
        const ready = await caches.match(READY, { cacheName: key });
        const timestamp = ready && (await ready.json()).preparedAt;
        // A newer install may be staging concurrently. Leave it to that worker.
        if (timestamp && timestamp < activatedAt) older.push({ key, activeAt: active ? Number(await active.text()) : 0 });
    }
    older.sort((a, b) => b.activeAt - a.activeAt);
    const keep = older.find(entry => entry.activeAt);
    await Promise.all(older.filter(entry => entry !== keep).map(entry => caches.delete(entry.key)));
}

async function preparedShellHash() {
    const responses = await Promise.all([READY, shellUrl(""), ...SHELL_FILES.map(shellUrl)].map(url =>
        caches.match(url, { cacheName: CACHE_NAME })));
    if (responses.every(Boolean)) return (await responses[0].json()).metadataHash;
    return null;
}

async function isSoleWindow(source) {
    if (source?.type !== "window") return false;
    try {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const inScope = windows.filter(client => client.url.startsWith(SCOPE.href));
        return inScope.length === 1 && inScope[0].id === source.id;
    } catch {
        return false;
    }
}

async function replyToUpdateRequest(event, reply) {
    try {
        const metadataHash = await preparedShellHash();
        if (event.data.type === "gac-app-inspect") {
            reply.postMessage({ buildId: BUILD_ID, metadataHash, soleWindow: await isSoleWindow(event.source) });
        } else if (!metadataHash || event.data.metadataHash !== metadataHash || event.data.buildId !== BUILD_ID) {
            reply.postMessage({ result: "unavailable" });
        } else if (!await isSoleWindow(event.source)) {
            reply.postMessage({ result: "other-windows" });
        } else if (!Number.isSafeInteger(event.data.deadline) || Date.now() >= event.data.deadline) {
            reply.postMessage({ result: "unavailable" });
        } else {
            // matchAll and the deadline check immediately precede skipWaiting.
            // The page separately waits for this exact worker to control it.
            const activation = self.skipWaiting();
            await activation;
            reply.postMessage({ result: "accepted", buildId: BUILD_ID });
        }
    } catch {
        reply.postMessage({ result: "unavailable" });
    }
}

async function serveShell(file, requestedBuild) {
    if (requestedBuild && requestedBuild !== BUILD_ID) {
        // A request already queued by an old page can outlive controllerchange.
        // Only a previously active, verified cache can satisfy that request.
        if (!BUILD_ID_PATTERN.test(requestedBuild)) return Response.error();
        const cacheName = CACHE_PREFIX + requestedBuild;
        if (!await caches.match(ACTIVE, { cacheName })) return Response.error();
        return await caches.match(shellUrl(file), { cacheName }) || Response.error();
    }
    return await caches.match(shellUrl(file), { cacheName: CACHE_NAME }) || Response.error();
}

if (BUILD_ID_PATTERN.test(BUILD_ID)) {
    self.addEventListener("install", event => {
        event.waitUntil(prepareShell().then(() => discardSupersededInstalls().catch(() => {})));
    });
    self.addEventListener("activate", event => event.waitUntil(claimShell()));
    self.addEventListener("message", event => {
        const reply = event.ports[0];
        if (reply && ["gac-app-inspect", "gac-app-activate"].includes(event.data?.type)) {
            event.waitUntil(replyToUpdateRequest(event, reply));
        }
    });

    self.addEventListener("fetch", event => {
        const url = new URL(event.request.url);
        if (event.request.method !== "GET" || !url.href.startsWith(SCOPE.href)) return;
        const file = url.pathname.slice(SCOPE.pathname.length);
        if (file === "app-build.json") {
            event.respondWith(fetch(event.request, { cache: "no-store" }));
        } else if (file === "" || SHELL_FILES.includes(file)) {
            const build = file === "" || file === "index.html" ? null : url.searchParams.get("build");
            event.respondWith(serveShell(file, build));
        }
        // Catalogue, roster and other requests use the browser's network path.
    });
}
