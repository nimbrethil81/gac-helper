const appUpdates = (() => {
    const scriptBuild = "__GAC_BUILD_ID__";
    const shellFiles = /* gac shell files */ [];
    const buildPattern = /^[0-9a-f]{64}$/;
    const reloadKey = "gacAppUpdateTarget";
    const copy = {
        checking: ["Checking for updates…"],
        preparing: ["Preparing new version…"],
        current: ["You're up to date", "Latest app version is running.", "Check for updates", "current"],
        ready: ["A new version is ready", "Update when you're ready.", "Update now", "download"],
        reloadReady: ["Reload to finish updating", "", "Reload app", "download"],
        editing: ["Update ready — finish editing", "Finish or cancel your edits first.", "", "pause"],
        working: ["Update ready — finish editing", "Wait for the current operation to finish.", "", "pause"],
        undo: ["Update ready — finish editing", "Use Undo or wait for it to expire first.", "", "pause"],
        windows: ["Update ready — close other app windows", "Close the other GAC Helper window(s) and try again.", "Check for updates", "pause"],
        offline: ["Offline — using saved version", "Reconnect to check for updates.", "Try again", "offline"],
        failed: ["Couldn't check for updates", "", "Try again"],
        interrupted: ["Couldn't complete the update", "", "Try again"],
        unsupported: ["App updates unavailable in this browser"],
        updating: ["Updating app…"]
    };

    let loadedBuild, workers, registration, checkRun, inspection, live, updateTarget, activation;
    let recoveryBuild, reloadTimer;
    let status = "checking";
    let dismissed = false;
    let failedInstall = false;
    let frozen = false;
    let reconnectTimer;
    const watched = new WeakSet();

    function icon(name) {
        const paths = {
            current: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.4 2.4 4.6-4.6"/>',
            download: '<path d="M12 3v12m-5-5 5 5 5-5M3 15v5h18v-5"/>',
            offline: '<path d="m3 3 18 18M2 9a16 16 0 0 1 4-2.5m4.5-1.3A16 16 0 0 1 22 9M5 13a12 12 0 0 1 5-2.5m5.5 0A12 12 0 0 1 19 13M8 17a6 6 0 0 1 8 0m-4 3v.01"/>',
            pause: '<circle cx="12" cy="12" r="9"/><path d="M10 8v8m4-8v8"/>',
            refresh: '<path d="M20 5v5h-5m4.6-.4a8 8 0 1 0 .1 5.3"/>',
            close: '<path d="m6 6 12 12M18 6 6 18"/>',
            neutral: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4v.01"/>'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
    }

    function layout() {
        const notice = document.getElementById("app-update-notice");
        const nav = document.querySelector(".bottom-nav");
        const navHeight = nav?.getBoundingClientRect().height || 0;
        const extra = notice && !notice.hidden ? notice.getBoundingClientRect().height + 2 : 0;
        document.body.style.setProperty("--bottom-nav-height", `${navHeight}px`);
        document.body.style.setProperty("--app-update-space", `${extra}px`);
    }

    function renderCard() {
        const buildLine = loadedBuild ? `Build ${loadedBuild.slice(0, 7)}` : "Build unavailable";
        return `<section class="round-card app-version-card" aria-labelledby="app-version-heading">
            <h2 id="app-version-heading">App version</h2>
            <p class="app-build-version">v${APP_VERSION} · ${buildLine}</p>
            <div class="app-update-status"><span data-update-icon></span><strong data-update-title></strong></div>
            <p class="app-update-explanation" data-update-explanation hidden></p>
            <button class="app-update-button" type="button" data-app-update-action hidden>
                <span data-update-button-icon></span><span data-update-button-label></span>
            </button>
        </section>`;
    }

    function keyboardOpen() {
        const viewport = window.visualViewport;
        return viewport && viewport.scale === 1 && window.innerHeight - viewport.height > 120;
    }

    function localBlocker() {
        return keyboardOpen() ? "editing" : appUpdateBlocker();
    }

    function viewStatus() {
        if (status !== "ready") return status;
        return localBlocker() || (!updateTarget.soleWindow ? "windows" : updateTarget.reloadOnly ? "reloadReady" : "ready");
    }

    function changeText(node, value) {
        if (node.textContent !== value) node.textContent = value;
    }

    function changeIcon(node, name) {
        if (node.dataset.icon !== name) {
            node.dataset.icon = name;
            node.innerHTML = icon(name);
        }
    }

    function refreshView() {
        const notice = document.getElementById("app-update-notice");
        if (!notice) return;
        const state = viewStatus();
        const [title, explanation = "", action = "", symbol = "neutral"] = copy[state];
        const card = document.querySelector(".app-version-card");
        if (card) {
            card.dataset.updateState = state;
            changeIcon(card.querySelector("[data-update-icon]"), symbol);
            changeText(card.querySelector("[data-update-title]"), title);
            const detail = card.querySelector("[data-update-explanation]");
            detail.hidden = !explanation;
            changeText(detail, explanation);
            const button = card.querySelector("button");
            const processing = ["checking", "preparing", "updating"].includes(state);
            button.hidden = !action && !processing;
            button.disabled = processing;
            const ready = state === "ready" || state === "reloadReady";
            button.classList.toggle("app-update-primary", ready);
            changeIcon(button.querySelector("[data-update-button-icon]"), ready ? "download" : "refresh");
            changeText(button.querySelector("[data-update-button-label]"), action || (state === "updating" ? "Update now" : "Check for updates"));
        }
        notice.hidden = !!card || currentView === "more" || state !== "ready" || dismissed;
        changeText(document.getElementById("app-update-announcement"), card || !notice.hidden ? title : "");
        layout();
    }

    function show(next) {
        status = next;
        refreshView();
    }

    function metadataValid(value) {
        return Object.keys(value ?? {}).sort().join() === "assets,buildId,contract,version" &&
            value.contract === "gac-app-build:v1" && typeof value.buildId === "string" && buildPattern.test(value.buildId) &&
            typeof value.version === "string" && /^[0-9]+(?:\.[0-9]+)+$/.test(value.version) &&
            Object.keys(value.assets ?? {}).length === shellFiles.length &&
            shellFiles.every(file => {
                const entry = value.assets[file];
                return Object.keys(entry ?? {}).sort().join() === "bytes,sha256" &&
                    Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && buildPattern.test(entry.sha256);
            });
    }

    async function readLiveBuild() {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 8000);
        try {
            const response = await fetch(`app-build.json?check=${Date.now()}`, {
                cache: "no-store", redirect: "error", signal: abort.signal
            });
            if (!response.ok) throw new Error("Build metadata unavailable");
            const bytes = await response.arrayBuffer();
            const metadata = JSON.parse(new TextDecoder().decode(bytes));
            if (!metadataValid(metadata)) throw new Error("Invalid build metadata");
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
            return { ...metadata, hash };
        } finally {
            clearTimeout(timer);
        }
    }

    function message(worker, data, timeoutMs = 1600) {
        return new Promise(resolve => {
            if (!worker) { resolve(null); return; }
            const channel = new MessageChannel();
            const finish = value => {
                clearTimeout(timer);
                channel.port1.close();
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            channel.port1.onmessage = event => finish(event.data);
            try { worker.postMessage(data, [channel.port2]); }
            catch { finish(null); }
        });
    }

    function inspect(worker) {
        return message(worker, { type: "gac-app-inspect" });
    }

    function verifiedBuild(reply, buildId, hash) {
        return reply?.buildId === buildId && reply.metadataHash === hash;
    }

    function controlsPage(worker) {
        return worker?.state === "activated" && workers.controller === worker && registration.active === worker;
    }

    function observeWorker(worker) {
        if (!worker || watched.has(worker)) return;
        watched.add(worker);
        let installed = !["parsed", "installing"].includes(worker.state);
        worker.addEventListener("statechange", () => {
            if (worker.state === "redundant" && !installed) failedInstall = true;
            if (["installed", "activating", "activated"].includes(worker.state)) installed = true;
            requestInspection();
        });
    }

    async function updateRegistration() {
        if (!registration) {
            const existing = await workers.getRegistration();
            const useExisting = existing?.scope === new URL("./", document.baseURI).href && existing.updateViaCache === "none";
            const result = useExisting ? existing : await workers.register("service-worker.js", { updateViaCache: "none" });
            result.addEventListener("updatefound", () => {
                observeWorker(result.installing);
                requestInspection();
            });
            observeWorker(result.installing);
            observeWorker(result.waiting);
            observeWorker(result.active);
            registration = result;
            // register() already checked the script. On an offline relaunch,
            // reuse the registration and issue just one check on reconnect.
            if (!useExisting) return;
        }
        await registration.update();
    }

    async function assess(metadata) {
        if (!loadedBuild && !recoveryBuild) { show("interrupted"); return; }
        const controller = workers.controller;
        const candidate = registration.waiting;
        const [active, installed] = await Promise.all([inspect(controller), inspect(candidate)]);
        if (live !== metadata || checkRun || activation) return;
        if (navigator.onLine === false) { show("offline"); return; }
        if (controller !== workers.controller || candidate !== registration.waiting) {
            requestInspection();
            return;
        }
        const activeMatches = controlsPage(controller) && verifiedBuild(active, metadata.buildId, metadata.hash);
        if (registration.installing || registration.active?.state === "activating") {
            show("preparing");
        } else if (loadedBuild === metadata.buildId && metadata.version === APP_VERSION && activeMatches &&
            !failedInstall && (!candidate || installed?.metadataHash === metadata.hash)) {
            show("current");
        } else if (loadedBuild !== metadata.buildId && recoveryBuild === metadata.buildId && activeMatches && !failedInstall) {
            updateTarget = { worker: controller, buildId: metadata.buildId, hash: metadata.hash, soleWindow: active.soleWindow === true, reloadOnly: true };
            show("ready");
        } else if (loadedBuild && candidate?.state === "installed" && verifiedBuild(installed, metadata.buildId, metadata.hash)) {
            updateTarget = { worker: candidate, buildId: metadata.buildId, hash: metadata.hash, soleWindow: installed.soleWindow === true, reloadOnly: false };
            show("ready");
        } else show(recoveryBuild ? "interrupted" : "failed");
    }

    function requestInspection() {
        if (!live || checkRun || activation) return;
        if (inspection) { inspection.again = true; return; }
        const run = { again: false };
        inspection = run;
        inspectUntilStable(run);
    }

    async function inspectUntilStable(run) {
        try {
            do {
                run.again = false;
                await assess(live);
            } while (run.again && live && !checkRun && !activation);
        } catch {
            if (!checkRun && !activation) show("failed");
        } finally {
            inspection = null;
        }
    }

    async function probe() {
        let timer;
        try {
            const update = updateRegistration();
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("App update check timed out")), 10000);
            });
            const [metadata] = await Promise.race([Promise.all([readLiveBuild(), update]), timeout]);
            live = metadata;
        } catch {
            show(navigator.onLine === false ? "offline" : "failed");
        } finally {
            clearTimeout(timer);
            checkRun = null;
            requestInspection();
        }
    }

    function check() {
        if (!workers || checkRun || activation) return;
        live = null;
        if (navigator.onLine === false) { show("offline"); return; }
        failedInstall = false;
        show("checking");
        checkRun = probe();
    }

    function resume() {
        dismissed = false;
        check();
    }

    function reconnect() {
        clearTimeout(reconnectTimer);
        // The page and its service worker can regain network access on
        // different ticks. Let that transition settle before checking both.
        reconnectTimer = setTimeout(async () => {
            if (checkRun) await checkRun;
            if (navigator.onLine !== false) check();
        }, 300);
    }

    function waitForControl(worker) {
        if (controlsPage(worker)) return Promise.resolve(true);
        return new Promise(resolve => {
            function finish(result) {
                clearTimeout(timer);
                workers.removeEventListener("controllerchange", changed);
                worker.removeEventListener("statechange", changed);
                resolve(result);
            }
            function changed() {
                if (controlsPage(worker)) finish(true);
                else if (worker.state === "redundant") finish(false);
            }
            const timer = setTimeout(() => finish(false), 6000);
            workers.addEventListener("controllerchange", changed);
            worker.addEventListener("statechange", changed);
            changed();
        });
    }

    function canReload() {
        return !localBlocker() && document.visibilityState === "visible" && navigator.onLine !== false;
    }

    function finishAttempt(next) {
        clearTimeout(reloadTimer);
        reloadTimer = undefined;
        frozen = false;
        activation = null;
        if (next === "interrupted") live = null;
        show(next);
    }

    async function activate() {
        if (activation || !["ready", "reloadReady"].includes(viewStatus())) return;
        const target = updateTarget;
        const { worker, buildId, hash, reloadOnly } = target;
        const targetAvailable = () => reloadOnly ? controlsPage(worker) : worker === registration.waiting && worker.state === "installed";
        activation = true;
        show("updating");
        let failure = "interrupted";
        try {
            const metadata = await readLiveBuild();
            if (metadata.buildId !== buildId || metadata.hash !== hash || !targetAvailable()) return;
            const installed = await inspect(worker);
            if (!verifiedBuild(installed, buildId, hash)) return;
            if (installed.soleWindow !== true) {
                target.soleWindow = false;
                failure = "ready";
                return;
            }
            if (!canReload()) {
                failure = navigator.onLine === false ? "offline" : "ready";
                return;
            }
            const backup = rosterBackup;
            if (backup && !confirm("Updating will end your chance to undo the last roster change. Update now?")) {
                failure = "ready";
                return;
            }
            if (!targetAvailable()) return;
            if (!canReload() || rosterBackup !== backup) {
                failure = navigator.onLine === false ? "offline" : "ready";
                return;
            }

            // Close the gap between the final draft check and the worker's
            // asynchronous client enumeration. The fence lasts through reload
            // or a bounded failure, and is never used while checking.
            sessionStorage.setItem(reloadKey, buildId);
            recoveryBuild = buildId;
            frozen = true;
            if (!reloadOnly) {
                const deadline = Date.now() + 2800;
                const result = await message(worker, { type: "gac-app-activate", buildId, metadataHash: hash, deadline }, 3500);
                if (result?.result === "other-windows") {
                    target.soleWindow = false;
                    failure = "ready";
                    return;
                }
                if (result?.result !== "accepted" || result.buildId !== buildId || !await waitForControl(worker)) return;
            }
            const active = await inspect(worker);
            if (!verifiedBuild(active, buildId, hash) || !controlsPage(worker)) return;
            if (active.soleWindow !== true || !canReload() || rosterBackup !== backup) {
                updateTarget = { ...target, soleWindow: active.soleWindow === true, reloadOnly: true };
                failure = navigator.onLine === false ? "offline" : "ready";
                return;
            }
            reloadTimer = setTimeout(() => {
                // Cancel a pending navigation before allowing editing again.
                try { window.stop(); } finally { finishAttempt("interrupted"); }
            }, 6000);
            location.reload();
            failure = null;
        } catch {
            // The existing page and saved shell remain available for a retry.
        } finally {
            if (failure) finishAttempt(failure);
        }
    }

    function onClick(event) {
        const button = event.target.closest?.("button");
        if (!button) return;
        if (button.matches("[data-app-update-dismiss]")) {
            dismissed = true;
            refreshView();
        } else if (button.matches("[data-app-update-action]")) {
            const state = viewStatus();
            if (state === "ready" || state === "reloadReady") activate();
            else if (["current", "failed", "interrupted", "offline", "windows"].includes(state)) check();
        }
    }

    function start() {
        const htmlBuild = document.querySelector('meta[name="gac-app-build"]')?.content;
        const dev = !buildPattern.test(scriptBuild) && htmlBuild === scriptBuild && APP_BUILD_ID === scriptBuild;
        loadedBuild = buildPattern.test(scriptBuild) && htmlBuild === scriptBuild && APP_BUILD_ID === scriptBuild ? scriptBuild : null;
        const host = document.createElement("div");
        host.innerHTML = `<div id="app-update-announcement" class="app-update-announcement" aria-live="polite"></div>
            <aside id="app-update-notice" class="app-update-notice" aria-label="App update" hidden>
                <div class="app-update-notice-row">
                    <span class="app-update-notice-icon">${icon("download")}</span>
                    <div><strong>${copy.ready[0]}</strong><p>${copy.ready[1]}</p></div>
                    <button class="app-update-dismiss" type="button" data-app-update-dismiss aria-label="Dismiss app update">${icon("close")}</button>
                </div>
                <button class="app-update-button app-update-primary" type="button" data-app-update-action>${icon("download")}${copy.ready[2]}</button>
            </aside>`;
        document.body.append(host);
        document.addEventListener("click", onClick);
        for (const type of ["click", "keydown", "beforeinput", "submit", "change"]) {
            document.addEventListener(type, event => {
                if (!frozen) return;
                event.preventDefault();
                event.stopImmediatePropagation();
            }, true);
        }
        for (const type of ["focusin", "focusout", "input", "change"]) {
            document.addEventListener(type, () => queueMicrotask(refreshView));
        }
        window.visualViewport?.addEventListener("resize", refreshView);
        window.addEventListener("resize", refreshView);
        if (typeof ResizeObserver === "function") {
            const observer = new ResizeObserver(layout);
            observer.observe(document.getElementById("app-update-notice"));
        }

        try { workers = navigator.serviceWorker; } catch {}
        if (dev || !workers || !globalThis.crypto?.subtle) { show("unsupported"); return; }
        workers.addEventListener("controllerchange", requestInspection);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") resume();
        });
        window.addEventListener("pageshow", event => {
            if (!event.persisted) return;
            if (reloadTimer !== undefined) finishAttempt("interrupted");
            resume();
        });
        window.addEventListener("online", reconnect);
        window.addEventListener("offline", () => {
            clearTimeout(reconnectTimer);
            if (!activation) { live = null; show("offline"); }
        });

        try {
            const target = sessionStorage.getItem(reloadKey);
            if (buildPattern.test(target ?? "") && target !== loadedBuild) recoveryBuild = target;
            else if (target) sessionStorage.removeItem(reloadKey);
        } catch {}
        if (!loadedBuild || recoveryBuild) show("interrupted");
        else check();
    }

    return { start, renderCard, refreshView, isActivating: () => frozen };
})();
