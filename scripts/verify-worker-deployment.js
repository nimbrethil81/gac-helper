async function main() {
    const baseUrl = process.argv[2];
    const expectNoindex = process.argv[3] === "true";

    if (!baseUrl) throw new Error("Usage: node scripts/verify-worker-deployment.js <base-url> <expect-noindex>");

    const url = new URL(baseUrl);
    if (url.protocol !== "https:") throw new Error("Worker verification requires an HTTPS base URL.");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Worker returned HTTP ${response.status}.`);

    const html = await response.text();
    if (!html.includes("SWGOH GAC Helper")) {
        throw new Error("Worker response did not contain the expected application title.");
    }

    const robots = response.headers.get("X-Robots-Tag") || "";
    if (expectNoindex && !/noindex/i.test(robots)) {
        throw new Error("Development Worker response is missing X-Robots-Tag: noindex.");
    }
    if (!expectNoindex && /noindex/i.test(robots)) {
        throw new Error("Production Worker response unexpectedly contains X-Robots-Tag: noindex.");
    }

    console.log(`Verified ${url.origin}${url.pathname} (${expectNoindex ? "development noindex" : "production"}).`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
