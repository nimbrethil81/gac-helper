export default {
    async fetch(request, env) {
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);

        if (env.NOINDEX === "true") {
            headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
        });
    }
};
